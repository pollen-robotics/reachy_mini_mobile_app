/**
 * "About & diagnostics" panel - the drilled-in sub-page of the robot
 * Settings sheet. The user reaches it by tapping the "About &
 * diagnostics" row in `<SettingsPanel>` (the Settings root);
 * the host (`RobotSessionScreen`) swaps this panel in for the root list.
 * It paints its OWN back header (`←  About & diagnostics`) to pop back
 * to the root list, while the topbar cog's `✕` dismisses the whole
 * sheet.
 *
 *   ┌──────────────────────────────────────┐
 *   │ ← session topbar stays visible    [✕]│  (cog ✕ dismisses sheet)
 *   ├──────────────────────────────────────┤
 *   │  ←  About & diagnostics              │  (back header, painted here)
 *   ├──────────────────────────────────────┤
 *   │  CONNECTION                          │
 *   │  ┌────────────────────────────────┐  │
 *   │  │ ● LAN              │  11 Mbps  │  │
 *   │  │ Remote IP      192.168.1.19[⧉] │  │
 *   │  └────────────────────────────────┘  │
 *   │                                      │
 *   │  SOFTWARE                            │
 *   │  ┌────────────────────────────────┐  │
 *   │  │ Daemon v1.7.1  │  App v0.6.3   │  │
 *   │  └────────────────────────────────┘  │
 *   │                                      │
 *   │  ACCOUNT                             │
 *   │  ┌────────────────────────────────┐  │
 *   │  │ Signed in           @hf-handle │  │
 *   │  │ Session ⓘ              ● Live  │  │
 *   │  └────────────────────────────────┘  │
 *   │                                      │
 *   │  ┌──────────────────────[⤢] [⧉]──┐  │
 *   │  │ Logs                            │  │
 *   │  │ 12:35:34 Daemon started...      │  │
 *   │  │             (eats all space)    │  │
 *   │  └─────────────────────────────────┘  │
 *   └──────────────────────────────────────┘
 *
 * Chrome: back header + topbar
 * ────────────────────────────
 * As a sub-page the panel paints a slim back header (`←  About &
 * diagnostics`) that calls `onBack` to return to the Settings root.
 * It still has NO hero identity card: the session topbar above keeps
 * carrying `<IdentityChipBar>` (robot name + transport chip + short
 * id) so the user always knows which robot they're inspecting, and
 * the full hardware id lives in the Robot section below. Body is
 * metadata + logs.
 *
 * Layout contract (driven by the host)
 * ────────────────────────────────────
 * This component is a self-sized flex column (`height: 100%`); the
 * HOST is responsible for placing it via a `position: fixed`
 * wrapper that sits BELOW the session topbar (`top: max(68px,
 * env(safe-area-inset-top) + 62px)`) and covers everything down
 * to the bottom of the viewport (body + bottom nav). The expected
 * pattern in `RobotSessionScreen` is:
 *
 *   {settingsOpen && settingsView === 'about' && (
 *     <Box sx={{ position: 'fixed', top: TOPBAR_HEIGHT,
 *                left: 0, right: 0, bottom: 0, zIndex: 1200 }}>
 *       <RobotInfoPanel onBack={...} onClose={...} ... />
 *     </Box>
 *   )}
 *
 * The panel itself never positions absolutely - that lets the host
 * decide where it lives without the panel having to know.
 *
 * `onBack` pops back to the Settings root (painted as the `←` in the
 * back header). `onClose` is the "fully dismiss the sheet" callback,
 * unused for now (the topbar cog's `✕` carries that affordance) but
 * kept on the API so descendants (e.g. a future "ssh me into this
 * robot" link) can dismiss the whole sheet when their work is done.
 *
 * Data plumbing
 * ─────────────
 *   - daemon version  : `useDaemonState()` (shared provider in
 *                       `RobotSessionScreen`, ensures one fetch).
 *   - WebRTC signals  : `webrtcTransport` prop from the session
 *                       handle (kind / bitrate / remote IP).
 *   - daemon logs     : `useDaemonLogs({ session, enabled })` -
 *                       gated on `enabled` so we don't subscribe
 *                       while the engine hasn't reached `ready`.
 */
import { useCallback, useState } from 'react';
import { Box, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import CloseFullscreenIcon from '@mui/icons-material/CloseFullscreen';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';

import { formatEntriesForCopy, useDaemonLogs } from '@/features/daemon-logs';
import { useDaemonState } from '@/features/daemon-state';
import type { TransportInfo } from '@/features/robot-session/transport-monitor';
import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';
import { DaemonLogConsole } from '@/ui/widgets/daemon-logs';
import { RobotPanel } from '@/ui/widgets/robot-panel';
import Section from '@/ui/design/Section';
import { FONT_WEIGHT, LAYOUT, STATUS, TYPO } from '@/ui/design/tokens';

/**
 * Per-kind label + dot colour. Mirrors what the old
 * `<CameraDebugOverlay>` exposed inside the camera frame; the same
 * three colours read consistently across the app (`STATUS.success`
 * for the happy-path LAN, `STATUS.info` for direct, `STATUS.warning`
 * for relay - the only kind worth noticing as a potential UX issue).
 */
const KIND_META = {
  checking: { label: 'Checking…', color: STATUS.info },
  lan: { label: 'LAN', color: STATUS.success },
  direct: { label: 'Direct', color: STATUS.info },
  relay: { label: 'Relay', color: STATUS.warning },
} as const;

const DOT_SIZE_PX = 8;

/**
 * Floor for the LOGS panel inside the view. Tuned so the live tail
 * dominates the lower part of the panel - users open this view mostly
 * to read logs, the metadata above is at-a-glance reference. Trimmed
 * from 244 to 188 px (~8 rows -> ~6 rows of `LogLineRow` at ~23 px
 * each) to claw back the height the new back header consumes, so the
 * metadata + logs fit without scrolling on first open on a typical
 * phone. The body still scrolls if they overflow on short viewports.
 */
const LOGS_MIN_HEIGHT_PX = 188;

interface RobotInfoPanelProps {
  /**
   * Returns to the root Settings page. This panel is now a drilled-in
   * sub-page of the Settings sheet ("About & diagnostics"), so it
   * paints its own back header (`←  About & diagnostics`) that calls
   * this to pop back one level (vs `onClose`, which dismisses the
   * whole sheet).
   */
  onBack: () => void;
  /**
   * Fully dismisses the Settings sheet. The host (`RobotSessionScreen`)
   * normally drives dismissal itself via the topbar cog's `[✕]`
   * button, but we keep this prop on the contract so future content
   * inside the panel (an SSH deep-link, a "report a bug" CTA that
   * opens its own surface, …) can close the sheet as a side-effect of
   * completing its own action.
   *
   * Unused for now - prefix with `_` to mark intent. Drop the
   * underscore the moment a child needs it.
   */
  onClose: () => void;
  /**
   * Full hardware id of the robot (immutable per machine). Surfaced
   * verbatim - not the 5-char short form the topbar used to show -
   * in the Robot section so the user can read / copy the complete
   * fingerprint for a bug report.
   */
  hardwareId: string | null;
  /**
   * Peer id fallback for the hardware id, used when the daemon
   * hasn't shipped the dedicated hardware-id field yet. Mirrors the
   * `fallbackId` plumbing the topbar's `<IdentityChipBar>` used to
   * carry.
   */
  fallbackId?: string | null;
  /**
   * Hugging Face handle of the signed-in user. `null` shouldn't
   * happen on this screen in practice (the user is by definition
   * signed in to reach `RobotSessionScreen`) but we still handle
   * it defensively.
   */
  username: string | null;
  /**
   * Slice of the session handle the panel consumes. Typed via
   * `Pick` so the dependency surface is explicit at the call site
   * and the panel can be unit-tested with a fake handle.
   */
  session: Pick<RobotSessionHandle, 'subscribeLogs' | 'webrtcTransport'>;
  /**
   * Becomes `true` once the engine has reached `ready` for the
   * first time. Gates the daemon log subscription so we don't
   * spam errors while the WebRTC link is still coming up.
   */
  isLive: boolean;
}

export default function RobotInfoPanel({
  onBack,
  onClose: _onClose,
  hardwareId,
  fallbackId,
  username,
  session,
  isLive,
}: RobotInfoPanelProps) {
  const { daemonVersion } = useDaemonState();
  const versionLabel = daemonVersion ? `v${daemonVersion}` : '—';
  const fullHardwareId = hardwareId ?? fallbackId ?? null;

  // Daemon log buffer. Lives in the panel host so the copy button
  // can sit in the panel's actions slot without subscribing twice
  // or threading callbacks. Subscribed for as long as the panel is
  // mounted (i.e. as long as `infoOpen` in the host); the panel's
  // mount lifecycle is controlled by the host so closing the panel
  // releases the subscription naturally. The same `logs` object is
  // passed to both the inline `<DaemonLogConsole>` and the
  // full-screen variant so they share the buffer (and the user
  // doesn't lose context when toggling).
  const logs = useDaemonLogs({ session, enabled: isLive });

  /**
   * Whether the logs are taking over the whole panel surface.
   * Toggled via the `OpenInFullIcon` action in the inline logs
   * panel header. When `true`, the body swaps to a full-bleed
   * `<DaemonLogConsole>` and the panel topbar relabels to "Logs"
   * with `[copy]` + `[close]` actions; the metadata sections are
   * unmounted. The `useDaemonLogs` subscription up here keeps
   * running across the swap so the buffer is preserved.
   */
  const [logsFullscreen, setLogsFullscreen] = useState(false);

  const handleCopyLogs = useCallback(async () => {
    const text = formatEntriesForCopy(logs.entries);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.warn('[robot-info-panel] clipboard.writeText for logs failed:', err);
    }
  }, [logs.entries]);

  // WebRTC kind + dot. While ICE is still gathering, `kind` is
  // `checking`; we still render a row (with a muted label) so the
  // section's row count stays stable as the link comes up.
  const webrtc = session.webrtcTransport;
  const webrtcMeta = webrtc ? KIND_META[webrtc.kind] : null;
  const remoteIp = formatRemoteIp(webrtc);
  const bitrate = formatBitrate(webrtc?.bps ?? null);
  const latency = formatLatency(webrtc?.rttMs ?? null);

  return (
    <Stack
      sx={{
        height: '100%',
        width: '100%',
        bgcolor: 'background.default',
        // Host wraps us in `position: fixed; top: <topbar>; left|
        // right|bottom: 0` so we cover body + bottom nav but NOT
        // the session topbar. We paint the bg here (not on the
        // host wrapper) so the panel is the self-contained visual
        // unit: drop it anywhere with a `height: 100%` contract
        // and it still reads as "a screen".
      }}
    >
      {logsFullscreen ? (
        /* Full-screen logs surface. The DaemonLogConsole paints
           edge-to-edge below a compact toolbar carrying:
             - `Logs / Live daemon journal`  : title + subtitle so
               the user knows what they're looking at even though
               the session topbar above doesn't relabel.
             - `[⧉ copy]`                    : copy buffer to
                                               clipboard.
             - `[↘ collapse]`                : back to the inline
               metadata+logs layout.
           Note: the session topbar's `[✕]` is the way to fully
           dismiss the info view; the toolbar's collapse button
           is the way to keep info open but get the metadata
           back. Two distinct affordances, two distinct buttons
           in two distinct locations. */
        <>
          <Stack
            direction="row"
            sx={[
              {
                alignItems: 'center',
                justifyContent: 'space-between',
              },
              theme => ({
                flexShrink: 0,
                px: 2,
                py: 1.25,
                minHeight: 48,
                borderBottom: `1px solid ${theme.palette.divider}`,
              }),
            ]}
          >
            <Stack
              direction="row"
              spacing={1}
              sx={{
                alignItems: 'baseline',
                minWidth: 0,
              }}
            >
              <Typography
                component="h2"
                sx={{
                  fontSize: TYPO.md,
                  fontWeight: FONT_WEIGHT.semibold,
                  color: 'text.primary',
                  lineHeight: 1.2,
                }}
              >
                Logs
              </Typography>
              <Typography
                component="span"
                sx={{
                  fontSize: TYPO.xs,
                  color: 'text.secondary',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                Live daemon journal
              </Typography>
            </Stack>
            <Stack
              direction="row"
              spacing={0.5}
              sx={{
                alignItems: 'center',
                flexShrink: 0,
              }}
            >
              {/* Icon-only actions, no Tooltip: this is a mobile
                  surface where tooltip would only surface on
                  long-press (undiscoverable). The `aria-label`
                  carries the wording for screen readers; the
                  glyphs (`⧉` copy, `⤓` collapse) are universal
                  enough on their own. */}
              <IconButton
                aria-label="Copy logs"
                onClick={handleCopyLogs}
                disabled={logs.entries.length === 0}
                size="small"
              >
                <ContentCopyIcon sx={{ fontSize: 18 }} />
              </IconButton>
              <IconButton
                aria-label="Collapse logs"
                onClick={() => setLogsFullscreen(false)}
                size="small"
              >
                <CloseFullscreenIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Stack>
          </Stack>
          <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
            <DaemonLogConsole
              entries={logs.entries}
              status={logs.status}
              errorMessage={logs.errorMessage}
              enabled={isLive}
            />
          </Box>
        </>
      ) : (
        <>
          {/* Back header: this panel is a drilled-in sub-page of the
              Settings sheet, so it paints its own `←` to pop back to
              the root Settings list (the topbar cog's `✕` dismisses the
              whole sheet). Title matches the Settings root header
              (`TYPO.xxl` / bold); no bottom hairline so it sits flush
              over the scrolling content like the root does. */}
          <Stack
            direction="row"
            spacing={0.5}
            sx={{
              flexShrink: 0,
              alignItems: 'center',
              // Match the Settings root header gutter (`px: 3` / `pt:
              // 3.5`) so navigating root <-> about doesn't shift the
              // header horizontally or vertically.
              px: 3,
              pt: 3.5,
              pb: 1,
            }}
          >
            {/* Negative inset cancels the small IconButton's internal
                padding so the arrow glyph lands exactly on the `px: 3`
                gutter, where the root header's cog/settings icon sits. */}
            <IconButton
              aria-label="Back to settings"
              onClick={onBack}
              size="small"
              sx={{ ml: -0.625 }}
            >
              <ArrowBackRoundedIcon sx={{ fontSize: 22 }} />
            </IconButton>
            <Typography
              component="h2"
              sx={{
                fontSize: TYPO.xxl,
                fontWeight: FONT_WEIGHT.bold,
                letterSpacing: '-0.3px',
                color: 'text.primary',
                lineHeight: 1.2,
              }}
            >
              About &amp; diagnostics
            </Typography>
          </Stack>
          {/* Body. Flex column hosting the compact metadata sections
              and the LOGS panel. The whole column is wrapped in
              `overflowY: auto` so the metadata can spill into a normal
              page scroll if the viewport is short, instead of squashing
              the LOGS panel. The LOGS panel itself uses `flex: 1,
              minHeight: …` to eat the leftover vertical space and
              scrolls internally. */}
          <Box
            sx={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              // Match the standard `px: 3` settings gutter so the
              // sections line up with the root Settings list content.
              px: 3,
              pt: 2,
              // Bottom safe-area padding so the LOGS panel's bottom
              // edge isn't hidden under the iOS home indicator (we
              // cover the BottomNavigation, which normally provided
              // its own safe-area inset).
              pb: `calc(${LAYOUT.safeAreaBottom} + 16px)`,
              overflowY: 'auto',
            }}
          >
            {/* Robot section. Carries the full, copyable hardware id -
            the immutable per-machine fingerprint. The topbar's
            identity bar now shows only the robot name + transport
            icon, so the complete identifier lives here where there's
            room to read and copy it into a bug report. */}
            <Section label="Robot">
              <MetadataRow
                label="Identifier"
                value={fullHardwareId ?? '—'}
                mono={Boolean(fullHardwareId)}
                copyable={Boolean(fullHardwareId)}
              />
            </Section>
            <Section label="Connection">
              {/* Physical `Transport` (Wi-Fi / USB) used to live here
              as its own row, but it's already surfaced by the
              chip in the hero card above; the section is now
              focused on the WebRTC-level signals (kind / IP /
              bitrate) that AREN'T in the hero card.

              Headline row collapses the two glanceable health
              signals (link kind + live bitrate) into a single
              two-cell strip - same two-cell pattern as the
              Software section but with the values pointing to
              opposite edges (kind flush-left, bitrate flush-
              right) so the row reads like a status bar: "what
              kind of link / how fast". The Remote IP stays on
              its own `MetadataRow` because it carries the copy
              affordance and a value (an IPv4 string) that needs
              room. */}
              <Stack
                direction="row"
                sx={[
                  {
                    alignItems: 'stretch',
                  },
                  theme => ({
                    px: 1.5,
                    py: 1,
                    minHeight: 40,
                    '&:not(:last-of-type)': {
                      borderBottom: `1px solid ${theme.palette.divider}`,
                    },
                  }),
                ]}
              >
                <Box
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'center',
                  }}
                >
                  {webrtcMeta ? (
                    <StatusDotLabel color={webrtcMeta.color} label={webrtcMeta.label} />
                  ) : (
                    <Typography component="span" sx={{ fontSize: TYPO.sm, color: 'text.disabled' }}>
                      —
                    </Typography>
                  )}
                </Box>
                <Box
                  sx={theme => ({
                    width: '1px',
                    alignSelf: 'stretch',
                    mx: 1.5,
                    my: 0.25,
                    bgcolor: theme.palette.divider,
                  })}
                />
                <Box
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                  }}
                >
                  <Typography
                    component="span"
                    sx={{
                      fontSize: TYPO.sm,
                      fontFamily:
                        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
                      color: bitrate ? 'text.primary' : 'text.disabled',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {bitrate ?? '—'}
                  </Typography>
                </Box>
              </Stack>
              {latency && (
                <MetadataRow
                  label="Latency"
                  info={
                    'Round-trip time on the live link, measured on the ' +
                    'WebRTC candidate pair. This is what drives the ' +
                    'signal bars in the topbar - lower is better (a LAN ' +
                    'link is a few ms, an internet hop tens of ms).'
                  }
                  value={latency}
                  mono
                />
              )}
              {remoteIp && <MetadataRow label="Remote IP" value={remoteIp} mono copyable />}
            </Section>
            {/* Software section. Both version numbers (daemon firmware
            + this mobile app) are surfaced together on ONE row,
            split into two equal cells by a hairline divider. The
            section header ("SOFTWARE") already names the group,
            so the row drops the redundant left-label column the
            other sections use and gives each version balanced
            visual weight - which is what the user actually copies
            into a bug report ("daemon X, app Y"). The version
            strings stay monospaced for legibility / line-up. */}
            <Section label="Software">
              <Stack
                direction="row"
                sx={{
                  alignItems: 'center',
                  px: 1.5,
                  py: 1,
                  minHeight: 40,
                }}
              >
                <VersionCell label="Daemon" value={versionLabel} />
                <Box
                  sx={theme => ({
                    width: '1px',
                    alignSelf: 'stretch',
                    mx: 1.5,
                    my: 0.25,
                    bgcolor: theme.palette.divider,
                  })}
                />
                <VersionCell label="App" value={`v${__APP_VERSION__}`} />
              </Stack>
            </Section>
            {/* Account section. Reassurance about which HF account is
            signed in (and what the support team will see attached to
            a bug report). The session-phase row that used to sit here
            was dropped: it's debug-grade jargon, and the WebRTC kind +
            latency above already answer "is the link healthy". */}
            <Section label="Account">
              <MetadataRow
                label="Signed in"
                value={username ? `@${username}` : '—'}
                mono={Boolean(username)}
              />
            </Section>
            {/* LOGS panel. Eats the leftover vertical space via
            `flex: 1, minHeight: …` so the user gets a generous live
            tail. Body has no padding so the terminal-style console
            paints its own dim bg edge-to-edge; the actions slot
            carries the [expand] + [copy] cluster so the user can
            either lift the logs to a dedicated full-screen view
            (`OpenInFullIcon`) or copy the buffer to the clipboard
            in one tap. */}
            <RobotPanel
              title="Logs"
              subtitle="Live daemon journal"
              actions={
                <>
                  {/* Same rationale as the fullscreen header: mobile
                  surface, no Tooltip, `aria-label` for AT. */}
                  <IconButton
                    aria-label="Expand logs"
                    onClick={() => setLogsFullscreen(true)}
                    size="small"
                    sx={{ width: 24, height: 24, p: 0.25 }}
                  >
                    <OpenInFullIcon sx={{ fontSize: 12 }} />
                  </IconButton>
                  <IconButton
                    aria-label="Copy logs"
                    onClick={handleCopyLogs}
                    disabled={logs.entries.length === 0}
                    size="small"
                    sx={{ width: 24, height: 24, p: 0.25 }}
                  >
                    <ContentCopyIcon sx={{ fontSize: 12 }} />
                  </IconButton>
                </>
              }
              noBodyChrome
              sx={{ flex: 1, minHeight: LOGS_MIN_HEIGHT_PX }}
            >
              <DaemonLogConsole
                entries={logs.entries}
                status={logs.status}
                errorMessage={logs.errorMessage}
                enabled={isLive}
              />
            </RobotPanel>
          </Box>
        </>
      )}
    </Stack>
  );
}

/**
 * Coloured-dot + label cluster, used as a value cell inside
 * `<MetadataRow>` for any "status-of-something" row (WebRTC
 * transport kind, session phase, …).
 *
 *   ●  LAN
 *
 * Centralised here so every status row in the panel has the same
 * dot size, gap, and typography. A future addition (e.g. daemon
 * health, motor mode) drops in by reusing this helper instead of
 * re-implementing the cluster inline.
 */
function StatusDotLabel({ color, label }: { color: string; label: string }) {
  return (
    <Stack
      direction="row"
      spacing={0.75}
      sx={{
        alignItems: 'center',
        minWidth: 0,
      }}
    >
      <Box
        aria-hidden
        sx={{
          width: DOT_SIZE_PX,
          height: DOT_SIZE_PX,
          borderRadius: '50%',
          bgcolor: color,
          flexShrink: 0,
        }}
      />
      <Typography
        component="span"
        sx={{
          fontSize: TYPO.sm,
          color: 'text.primary',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </Typography>
    </Stack>
  );
}

/**
 * One half of the "Software" row - a muted inline label followed
 * by a monospaced version string. Two of these sit side-by-side
 * inside the Software `<Section>`, separated by a hairline
 * divider, so the user reads both versions ("daemon X, app Y")
 * on a single visual line instead of stacked rows.
 *
 * `flex: 1` + `minWidth: 0` lets each cell shrink with truncation
 * if either version string blows out the row width (e.g. a long
 * pre-release tag); the labels stay pinned at full width thanks
 * to `flexShrink: 0`.
 */
function VersionCell({ label, value }: { label: string; value: string }) {
  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{
        alignItems: 'baseline',
        flex: 1,
        minWidth: 0,
      }}
    >
      <Typography
        component="span"
        sx={{
          fontSize: TYPO.sm,
          color: 'text.secondary',
          flexShrink: 0,
        }}
      >
        {label}
      </Typography>
      <Typography
        component="span"
        sx={{
          fontSize: TYPO.sm,
          color: 'text.primary',
          fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </Typography>
    </Stack>
  );
}

/**
 * One key/value row inside a `<Section>`. The label sits on the
 * left in `text.secondary`; the value column is right-aligned and
 * carries the bright text. An optional `copyable` flag renders a
 * small trailing copy button that lifts the row's value to the
 * clipboard. Uses `<Divider component="li">`-style hairlines via
 * `:not(:last-of-type)` so the bottom row stays clean.
 */
function MetadataRow({
  label,
  value,
  mono = false,
  copyable = false,
  info,
}: {
  label: string;
  value: React.ReactNode;
  /** Render the value in monospace (ids, IPs, version strings). */
  mono?: boolean;
  /** Render a trailing copy button. Only works for string values. */
  copyable?: boolean;
  /**
   * When set, render a small `ⓘ` icon next to the label that
   * surfaces this string on hover (desktop) / long-press
   * (mobile via MUI's Tooltip touch fallback). Use for rows
   * whose meaning is opaque from the label alone (e.g. the
   * `Session` row in the Account section).
   */
  info?: string;
}) {
  const stringValue = typeof value === 'string' ? value : null;

  const handleCopy = useCallback(async () => {
    if (!stringValue) return;
    try {
      await navigator.clipboard.writeText(stringValue);
    } catch (err) {
      console.warn('[robot-info-panel] clipboard.writeText failed:', err);
    }
  }, [stringValue]);

  return (
    <Stack
      direction="row"
      spacing={1}
      sx={[
        {
          alignItems: 'center',
        },
        theme => ({
          px: 1.5,
          py: 1,
          minHeight: 40,
          '&:not(:last-of-type)': {
            borderBottom: `1px solid ${theme.palette.divider}`,
          },
        }),
      ]}
    >
      <Stack
        direction="row"
        spacing={0.5}
        sx={{
          alignItems: 'center',
          flexShrink: 0,
        }}
      >
        <Typography
          component="span"
          sx={{
            fontSize: TYPO.sm,
            color: 'text.secondary',
          }}
        >
          {label}
        </Typography>
        {info && (
          <Tooltip title={info} arrow enterTouchDelay={0} leaveTouchDelay={4000}>
            <InfoOutlinedIcon
              aria-label={`What is ${label.toLowerCase()}?`}
              sx={{
                fontSize: 14,
                color: 'text.disabled',
                cursor: 'help',
              }}
            />
          </Tooltip>
        )}
      </Stack>
      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: 0.5,
        }}
      >
        {stringValue !== null ? (
          <Typography
            component="span"
            sx={{
              fontSize: TYPO.sm,
              color: 'text.primary',
              fontFamily: mono
                ? 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace'
                : undefined,
              textAlign: 'right',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            {value}
          </Typography>
        ) : (
          value
        )}
        {copyable && stringValue && (
          // Icon-only copy affordance, no Tooltip on mobile (same
          // rationale as the logs header). `aria-label` carries
          // the per-row wording for screen readers.
          <IconButton
            aria-label={`Copy ${label.toLowerCase()}`}
            size="small"
            onClick={handleCopy}
            sx={{ width: 24, height: 24, p: 0.25 }}
          >
            <ContentCopyIcon sx={{ fontSize: 12 }} />
          </IconButton>
        )}
      </Box>
    </Stack>
  );
}

/**
 * Hide an mDNS `.local` hostname on LAN: the LAN dot already
 * carries the "same network" signal and the hostname isn't directly
 * SSH-friendly. Real IPv4/IPv6 values are returned as-is. Returns
 * an empty string when the row has nothing meaningful to show
 * (caller checks truthiness to drop the row entirely).
 */
function formatRemoteIp(webrtc: TransportInfo | null | undefined): string {
  if (!webrtc || !webrtc.remoteIp) return '';
  const normalised = webrtc.remoteIp.toLowerCase();
  const isMdns = normalised.endsWith('.local') || normalised.endsWith('.local.');
  if (isMdns && webrtc.kind === 'lan') return '';
  return webrtc.remoteIp;
}

/**
 * Format `bps` as a kbps / Mbps string with one decimal until the
 * value gets fat enough to read cleanly without (≥ 10 Mbps or ≥ 100
 * kbps). Returns `''` for "no point displaying" so the caller can
 * just check truthiness to drop the row entirely.
 */
function formatBitrate(bps: number | null): string {
  if (bps === null || !Number.isFinite(bps) || bps <= 0) return '';
  if (bps >= 1_000_000) {
    const mbps = bps / 1_000_000;
    return `${mbps.toFixed(mbps >= 10 ? 0 : 1)} Mbps`;
  }
  const kbps = bps / 1_000;
  return `${kbps.toFixed(kbps >= 100 ? 0 : 1)} kbps`;
}

/**
 * Format the candidate-pair RTT as a `… ms` string. One decimal under
 * 10 ms (sub-LAN territory where the extra precision is meaningful),
 * rounded to an integer above. Returns `''` for "nothing to show" so
 * the caller drops the row entirely (e.g. iOS WKWebView, which doesn't
 * expose RTT, or before a pair is nominated).
 */
function formatLatency(rttMs: number | null): string {
  if (rttMs === null || !Number.isFinite(rttMs) || rttMs < 0) return '';
  return `${rttMs < 10 ? rttMs.toFixed(1) : Math.round(rttMs)} ms`;
}
