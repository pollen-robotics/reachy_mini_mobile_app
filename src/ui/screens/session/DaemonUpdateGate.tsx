/**
 * Daemon update gate.
 *
 * Rendered inside a live robot session. Right after the robot comes
 * online it compares the daemon's reported version against the latest
 * public release (GitHub). When the robot is behind, it takes over the
 * whole screen with a blocking "Update required" prompt and drives the
 * in-session update end to end:
 *
 *   prompt → updating → rebooting → done
 *                    ↘ failed
 *
 * Transport model
 * ───────────────
 * The update is fire-and-ack over the WebRTC data channel
 * (`start_update`, see pollen-robotics/reachy_mini#1208): the daemon
 * acks immediately, installs in the background, then `systemctl
 * restart`s itself. NO progress is streamed — so we:
 *   - show the live daemon log tail (`subscribeLogs`) while it runs,
 *   - treat the session dropping out of `live` as "the restart began"
 *     (→ rebooting),
 *   - re-read the version when the session comes back to confirm.
 *
 * The restart often outlasts the engine's auto-reconnect budget, so we
 * never trap the user: a "Back to robots" exit is always available to
 * reconnect from the lobby once the robot is back.
 *
 * Fail-open: if the latest version is unknown (offline / rate-limited),
 * `isDaemonOutdated` returns false and this gate renders nothing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Button, Collapse, Stack, Typography, CircularProgress } from '@mui/material';
import ArrowBackIosNewIcon from '@mui/icons-material/ArrowBackIosNew';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded';

import updateBoxUrl from '@/assets/reachy-update-box.svg';
import { compareSemver, isDaemonOutdated, parseSemver } from '@/features/daemon-update/latestRelease';
import { useDaemonLogs } from '@/features/daemon-logs';
import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';
import { DaemonLogConsole } from '@/ui/widgets/daemon-logs';
import { openExternalUrl } from '@/shared/tauri/openUrl';
import { FONT_WEIGHT, LAYOUT, RADIUS, TYPO } from '@/ui/design/tokens';

/** If the daemon never restarts within this window after we asked it to
 *  update, something went wrong silently → surface a failure. */
const UPDATE_STALL_TIMEOUT_MS = 180_000;

/**
 * First daemon release that understands the in-app WebRTC `start_update`
 * command (reachy_mini#1208, landed in v1.8.2). Below this - or when the
 * daemon never reported its version - the in-app "Update now" path can't
 * work, so we send the user to the Reachy desktop app instead of offering
 * a button that would silently do nothing.
 */
const MIN_DAEMON_VERSION_FOR_SELF_UPDATE = '1.8.2';

/** Public troubleshooting docs - same target as the Help & Support overlay. */
const TROUBLESHOOTING_URL = 'https://huggingface.co/docs/reachy_mini/troubleshooting';

/** Showcase site download page (Reachy Mini website Space). Where users
 *  grab the desktop app that can update a daemon too old for OTA. */
const DESKTOP_APP_DOWNLOAD_URL = 'https://pollen-robotics-reachy-mini-website.hf.space/download';

/**
 * Dev-only escape hatch for the blocking update prompt.
 *
 * When testing a daemon built from a feature branch (e.g. one based on
 * v1.8.3 while the latest public release is v1.8.4), `isDaemonOutdated`
 * trips and the prompt offers no skip - so a developer connected to a
 * branch build would be forced through "Update now", which pip-installs
 * the released wheel and wipes the branch under test. This flag surfaces a
 * discreet "Skip" button that dismisses the gate for the session without
 * touching the daemon.
 *
 * `import.meta.env.DEV` is statically `false` in any production build
 * (`vite build`), so both the flag and the button are tree-shaken away:
 * release users always hit the hard gate. Matches the dev-only gating of
 * `VITE_DEV_HF_TOKEN` & friends in `shared/env.ts`.
 */
const DEV_BYPASS = import.meta.env.DEV;

/** True only when the daemon version is known AND new enough to self-update
 *  over the WebRTC data channel. Unknown / unparseable → false (→ desktop
 *  app fallback). */
function supportsSelfUpdate(current: string | null): boolean {
  const c = parseSemver(current);
  const min = parseSemver(MIN_DAEMON_VERSION_FOR_SELF_UPDATE);
  return !!c && !!min && compareSemver(c, min) >= 0;
}

type Phase = 'idle' | 'prompt' | 'updating' | 'rebooting' | 'done' | 'failed';

interface DaemonUpdateGateProps {
  /** Live session handle (version read, update trigger, log stream). */
  session: RobotSessionHandle;
  /** Latest published daemon version, or `null` when unknown. */
  latestVersion: string | null;
  /** Leave the session and return to the robot list. */
  onBackToRobots: () => void;
}

export default function DaemonUpdateGate({
  session,
  latestVersion,
  onBackToRobots,
}: DaemonUpdateGateProps) {
  const live = session.phase === 'live';
  const [phase, setPhase] = useState<Phase>('idle');
  // Once the user has cleared the flow (Continue), don't reopen for the
  // rest of this session even if a version read momentarily lags.
  const completedRef = useRef(false);

  const { getDaemonVersion } = session;

  // Initial detection reads the version the connection layer resolved
  // DURING bring-up (`session.daemonVersion`), emitted just before the
  // session reached `live`. Reading it here - rather than firing our own
  // post-`ready` `get_version` round-trip - is what removes the visible
  // latency between "connected" and the gate appearing: the value is
  // already known the instant this screen mounts, so an outdated robot
  // shows the gate immediately instead of flashing the live UI first.
  const daemonVersion = session.daemonVersion;
  // After a post-update reboot the provider won't refetch (its version
  // is sticky across reacquires), so we re-read it directly once we
  // reconnect to confirm the new version. This overrides the provider
  // value when present.
  const [confirmedVersion, setConfirmedVersion] = useState<string | null>(null);
  const current = confirmedVersion ?? daemonVersion;

  const outdated = isDaemonOutdated(current, latestVersion);
  // Can this robot update itself from the app? Needs a daemon new enough to
  // understand the WebRTC `start_update` command. When false, the prompt
  // switches to a "use the desktop app" message instead of "Update now".
  const canSelfUpdate = supportsSelfUpdate(current);

  // Derive the prompt SYNCHRONOUSLY (no effect) the moment we positively
  // know the robot is behind. Flipping `phase` from an effect would leave
  // one frame where the connecting overlay is gone but the gate hasn't
  // mounted yet → the live UI flickers through. Computing it during render
  // means the gate paints in the same commit the session turns `live`,
  // with no intermediate "connected" frame. Once the user has cleared the
  // flow (`completedRef`) or kicked off the update (`phase` ≠ idle), the
  // real `phase` state takes over.
  const shouldBlock = live && outdated && !completedRef.current;
  const effectivePhase: Phase = phase === 'idle' && shouldBlock ? 'prompt' : phase;

  // The restart tore the transport down → we're rebooting.
  useEffect(() => {
    if (phase === 'updating' && !live) setPhase('rebooting');
  }, [phase, live]);

  // Reconnected after the restart → confirm and finish.
  useEffect(() => {
    if (phase !== 'rebooting' || !live) return;
    let cancelled = false;
    void getDaemonVersion().then((v) => {
      if (cancelled) return;
      if (typeof v === 'string' && v.length > 0) setConfirmedVersion(v);
      completedRef.current = true;
      setPhase('done');
    });
    return () => {
      cancelled = true;
    };
  }, [phase, live, getDaemonVersion]);

  // Safety net: the daemon acked but never restarted within the window.
  useEffect(() => {
    if (phase !== 'updating') return;
    const t = window.setTimeout(() => setPhase('failed'), UPDATE_STALL_TIMEOUT_MS);
    return () => window.clearTimeout(t);
  }, [phase]);

  // Logs are only shown while actively installing. During `rebooting` the
  // transport is gone anyway and a dead log tail just adds noise while the user
  // waits, so we hide it (see the reboot copy below, which sets expectations).
  const logsActive = phase === 'updating';
  const logs = useDaemonLogs({ session, enabled: logsActive });

  const handleUpdateNow = useCallback(() => {
    const ok = session.startDaemonUpdate();
    setPhase(ok ? 'updating' : 'failed');
  }, [session]);

  const handleContinue = useCallback(() => {
    completedRef.current = true;
    setPhase('idle');
  }, []);

  if (effectivePhase === 'idle') return null;

  return (
    <Box
      sx={{
        position: 'fixed',
        inset: 0,
        // Above the connecting / leaving overlays (1300) so the update
        // narrative wins while the post-restart reconnection churns.
        zIndex: 1400,
        bgcolor: 'background.default',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        px: 3,
        pt: LAYOUT.safeAreaTop,
        pb: `calc(${LAYOUT.safeAreaBottom} + 16px)`,
      }}
    >
      {/* Top-right exit: leave the session and reconnect from the lobby. Hidden
          while the update is actively installing (no safe bail-out) and on the
          success screen (Continue is the natural next step). */}
      {(effectivePhase === 'prompt' ||
        effectivePhase === 'rebooting' ||
        effectivePhase === 'failed') && (
        <Button
          onClick={onBackToRobots}
          startIcon={<ArrowBackIosNewIcon sx={{ fontSize: 14 }} />}
          sx={{
            position: 'absolute',
            top: `calc(${LAYOUT.safeAreaTop} + 8px)`,
            left: 8,
            color: 'text.secondary',
            textTransform: 'none',
            fontWeight: FONT_WEIGHT.semibold,
            fontSize: TYPO.sm,
            borderRadius: 999,
          }}
        >
          Back to robots
        </Button>
      )}

      <Stack spacing={2.5} sx={{ alignItems: 'center', width: '100%', maxWidth: 360 }}>
        <PhaseIcon phase={effectivePhase} />

        <Stack spacing={1} sx={{ alignItems: 'center' }}>
          <Typography
            component="h2"
            sx={{
              fontSize: TYPO.xl,
              fontWeight: FONT_WEIGHT.bold,
              textAlign: 'center',
              letterSpacing: '-0.2px',
            }}
          >
            {titleFor(effectivePhase, canSelfUpdate)}
          </Typography>
          <Typography
            sx={{
              fontSize: TYPO.sm,
              color: 'text.secondary',
              textAlign: 'center',
              lineHeight: 1.5,
              maxWidth: 320,
            }}
          >
            {bodyFor(effectivePhase, current, latestVersion, canSelfUpdate)}
          </Typography>
        </Stack>

        {logsActive && (
          <UpdateLogDisclosure
            entries={logs.entries}
            status={logs.status}
            errorMessage={logs.errorMessage}
            enabled={logsActive}
          />
        )}

        <Stack spacing={1} sx={{ width: '100%', alignItems: 'center' }}>
          {effectivePhase === 'prompt' && canSelfUpdate && (
            <PrimaryButton onClick={handleUpdateNow}>Update now</PrimaryButton>
          )}
          {effectivePhase === 'done' && (
            <PrimaryButton onClick={handleContinue}>Continue</PrimaryButton>
          )}
          {effectivePhase === 'failed' && canSelfUpdate && (
            <PrimaryButton onClick={() => setPhase('prompt')}>Try again</PrimaryButton>
          )}
          {((effectivePhase === 'prompt' && !canSelfUpdate) || effectivePhase === 'failed') && (
            <PrimaryButton onClick={() => void openExternalUrl(DESKTOP_APP_DOWNLOAD_URL)}>
              Get the desktop app ↗
            </PrimaryButton>
          )}
          {((effectivePhase === 'prompt' && !canSelfUpdate) ||
            effectivePhase === 'failed') && <TroubleshootingLink />}
          {effectivePhase === 'prompt' && DEV_BYPASS && (
            <DevSkipButton onClick={handleContinue} />
          )}
        </Stack>
      </Stack>
    </Box>
  );
}

function PhaseIcon({ phase }: { phase: Phase }) {
  if (phase === 'updating' || phase === 'rebooting') {
    return <CircularProgress size={32} sx={{ color: 'text.secondary' }} />;
  }
  if (phase === 'done') {
    return <CheckCircleRoundedIcon sx={{ fontSize: 56, color: 'success.main' }} />;
  }
  if (phase === 'failed') {
    return <ErrorOutlineRoundedIcon sx={{ fontSize: 56, color: 'error.main' }} />;
  }
  return <Box component="img" src={updateBoxUrl} alt="" aria-hidden sx={{ width: 200, height: 200 }} />;
}

function titleFor(phase: Phase, canSelfUpdate: boolean): string {
  switch (phase) {
    case 'updating':
      return 'Updating your Reachy…';
    case 'rebooting':
      return 'Reachy is rebooting…';
    case 'done':
      return 'Reachy is up to date';
    case 'failed':
      return "Update couldn't start";
    default:
      return canSelfUpdate ? 'Update required' : 'Update from the desktop app';
  }
}

function bodyFor(
  phase: Phase,
  current: string | null,
  latest: string | null,
  canSelfUpdate: boolean,
): string {
  switch (phase) {
    case 'updating':
      return 'Installing the latest software. Keep the app open - the robot will reboot when it is done. This usually takes about 1-2 minutes.';
    case 'rebooting':
      return 'Reachy is restarting to finish the update. This usually takes a minute or two - keep the app open and stay nearby while it comes back online.';
    case 'done':
      return current ? `Now running v${current}.` : 'Your Reachy is now up to date.';
    case 'failed':
      return 'The robot did not respond to the update request. Make sure you are close to it and it is online, then try again - or update it from the Reachy desktop app.';
    default:
      // `prompt`. Two flavours: a daemon new enough to update itself from the
      // app, vs. one that's too old (or silent) and must be updated from the
      // desktop app.
      if (!canSelfUpdate) {
        return current
          ? `This Reachy runs v${current}, which is too old to update over the air. Install the Reachy desktop app to update it, then reconnect here.`
          : `This Reachy needs version v${MIN_DAEMON_VERSION_FOR_SELF_UPDATE} or newer to update from the app. Install the Reachy desktop app to update it, then reconnect here.`;
      }
      return current && latest
        ? `This Reachy runs v${current}. Version v${latest} is required to continue. The robot will reboot during the update (~2 min).`
        : 'A required software update is available for this Reachy.';
  }
}

/** Collapsible live daemon log tail shown while the update runs. */
function UpdateLogDisclosure({
  entries,
  status,
  errorMessage,
  enabled,
}: {
  entries: ReturnType<typeof useDaemonLogs>['entries'];
  status: ReturnType<typeof useDaemonLogs>['status'];
  errorMessage: string | null;
  enabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Stack spacing={0.5} sx={{ width: '100%', alignItems: 'center' }}>
      <Button
        onClick={() => setOpen((v) => !v)}
        size="small"
        sx={{
          textTransform: 'none',
          fontSize: TYPO.xs,
          fontWeight: FONT_WEIGHT.medium,
          color: 'text.secondary',
        }}
      >
        {open ? '▾ Hide details' : '▸ Show details'}
      </Button>
      <Collapse in={open} sx={{ width: '100%' }}>
        <Box
          sx={(theme) => ({
            width: '100%',
            height: 180,
            display: 'flex',
            borderRadius: `${RADIUS.md}px`,
            border: `1px solid ${theme.palette.divider}`,
            overflow: 'hidden',
          })}
        >
          <DaemonLogConsole
            entries={entries}
            status={status}
            errorMessage={errorMessage}
            enabled={enabled}
          />
        </Box>
      </Collapse>
    </Stack>
  );
}

/** Dev-only "skip the gate" button. Rendered only in dev builds (see
 *  {@link DEV_BYPASS}); dismisses the prompt for the session so a branch
 *  daemon can be tested without being force-updated to the latest wheel. */
function DevSkipButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      onClick={onClick}
      size="small"
      sx={{
        textTransform: 'none',
        fontSize: TYPO.xs,
        fontWeight: FONT_WEIGHT.medium,
        color: 'text.secondary',
        opacity: 0.7,
      }}
    >
      Skip for now (dev build)
    </Button>
  );
}

/** Subtle link to the public troubleshooting docs - shown when the update
 *  can't run from the app, in case there's something to fix on that page. */
function TroubleshootingLink() {
  return (
    <Button
      onClick={() => void openExternalUrl(TROUBLESHOOTING_URL)}
      size="small"
      sx={{
        textTransform: 'none',
        fontSize: TYPO.sm,
        fontWeight: FONT_WEIGHT.medium,
        color: 'text.secondary',
      }}
    >
      Open troubleshooting guide ↗
    </Button>
  );
}

function PrimaryButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="outlined"
      color="primary"
      onClick={onClick}
      fullWidth
      sx={{
        textTransform: 'none',
        fontSize: TYPO.md,
        fontWeight: FONT_WEIGHT.semibold,
        borderRadius: `${RADIUS.md}px`,
        py: 1.25,
        maxWidth: 280,
      }}
    >
      {children}
    </Button>
  );
}
