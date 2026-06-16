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
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded';
import SystemUpdateAltRoundedIcon from '@mui/icons-material/SystemUpdateAltRounded';

import { isDaemonOutdated } from '@/features/daemon-update/latestRelease';
import { useDaemonLogs } from '@/features/daemon-logs';
import { useDaemonState } from '@/features/daemon-state';
import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';
import { DaemonLogConsole } from '@/ui/widgets/daemon-logs';
import { FONT_WEIGHT, LAYOUT, RADIUS, TYPO } from '@/ui/design/tokens';

/** If the daemon never restarts within this window after we asked it to
 *  update, something went wrong silently → surface a failure. */
const UPDATE_STALL_TIMEOUT_MS = 180_000;

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

  // Initial detection reads the SHARED daemon version from the
  // provider. That hook owns a robust retry-on-null fetch, so the
  // value reliably resolves shortly after connect - unlike a one-shot
  // `getDaemonVersion()` fired on the `live` edge, which races the
  // provider's own `get_version` round-trip on the same data channel
  // and frequently came back `null` (the prompt then never opened).
  const { daemonVersion } = useDaemonState();
  // After a post-update reboot the provider won't refetch (its version
  // is sticky across reacquires), so we re-read it directly once we
  // reconnect to confirm the new version. This overrides the provider
  // value when present.
  const [confirmedVersion, setConfirmedVersion] = useState<string | null>(null);
  const current = confirmedVersion ?? daemonVersion;

  const outdated = isDaemonOutdated(current, latestVersion);

  // Open the prompt once we positively know the robot is behind.
  useEffect(() => {
    if (phase === 'idle' && live && outdated && !completedRef.current) {
      setPhase('prompt');
    }
  }, [phase, live, outdated]);

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

  const logsActive = phase === 'updating' || phase === 'rebooting';
  const logs = useDaemonLogs({ session, enabled: logsActive });

  const handleUpdateNow = useCallback(() => {
    const ok = session.startDaemonUpdate();
    setPhase(ok ? 'updating' : 'failed');
  }, [session]);

  const handleContinue = useCallback(() => {
    completedRef.current = true;
    setPhase('idle');
  }, []);

  if (phase === 'idle') return null;

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
      <Stack spacing={2.5} sx={{ alignItems: 'center', width: '100%', maxWidth: 360 }}>
        <PhaseIcon phase={phase} />

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
            {titleFor(phase)}
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
            {bodyFor(phase, current, latestVersion)}
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
          {phase === 'prompt' && (
            <>
              <PrimaryButton onClick={handleUpdateNow}>Update now</PrimaryButton>
              <TextLink onClick={onBackToRobots}>Back to robots</TextLink>
            </>
          )}
          {phase === 'rebooting' && <TextLink onClick={onBackToRobots}>Back to robots</TextLink>}
          {phase === 'done' && <PrimaryButton onClick={handleContinue}>Continue</PrimaryButton>}
          {phase === 'failed' && (
            <>
              <PrimaryButton onClick={() => setPhase('prompt')}>Try again</PrimaryButton>
              <TextLink onClick={onBackToRobots}>Back to robots</TextLink>
            </>
          )}
        </Stack>
      </Stack>
    </Box>
  );
}

function PhaseIcon({ phase }: { phase: Phase }) {
  if (phase === 'updating' || phase === 'rebooting') {
    return <CircularProgress size={48} sx={{ color: 'primary.main' }} />;
  }
  if (phase === 'done') {
    return <CheckCircleRoundedIcon sx={{ fontSize: 56, color: 'success.main' }} />;
  }
  if (phase === 'failed') {
    return <ErrorOutlineRoundedIcon sx={{ fontSize: 56, color: 'error.main' }} />;
  }
  return <SystemUpdateAltRoundedIcon sx={{ fontSize: 56, color: 'primary.main' }} />;
}

function titleFor(phase: Phase): string {
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
      return 'Update required';
  }
}

function bodyFor(phase: Phase, current: string | null, latest: string | null): string {
  switch (phase) {
    case 'updating':
      return 'Installing the latest software. Keep the app open - the robot will reboot when it is done.';
    case 'rebooting':
      return 'Finishing the update and restarting. This can take a minute. You can wait here or reconnect from the robot list once it is back.';
    case 'done':
      return current ? `Now running v${current}.` : 'Your Reachy is now up to date.';
    case 'failed':
      return 'The update could not be started. Make sure you are close to the robot and that it is online, then try again.';
    default:
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

function PrimaryButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="contained"
      color="primary"
      disableElevation
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

function TextLink({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <Button
      onClick={onClick}
      sx={{
        textTransform: 'none',
        fontSize: TYPO.sm,
        fontWeight: FONT_WEIGHT.medium,
        color: 'text.secondary',
      }}
    >
      {children}
    </Button>
  );
}
