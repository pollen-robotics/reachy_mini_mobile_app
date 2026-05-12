/**
 * Debug overlay anchored to the bottom-left of the camera frame.
 *
 *   ┌────────────────────────────────┐
 *   │ <video>                         │
 *   │                                 │
 *   │ ┌────────────────────┐          │
 *   │ │ ver   v1.7.1        │  ← row 1 : daemon version
 *   │ │ net   ● LAN         │  ← row 2 : WebRTC kind + dot
 *   │ │ ip    192.168.1.151 │  ← row 3 : reachable IP (hidden on relay)
 *   │ │ rate  32 kbps       │  ← row 4 : instantaneous bitrate
 *   │ └────────────────────┘          │
 *   │                          ╭──╮   │
 *   │  <head joystick>         │··│   │  ← unrelated overlay, kept far
 *   │                          ╰──╯   │     away in the opposite corner
 *   └────────────────────────────────┘
 *
 * Aggregates the debug-grade connection signals that don't belong
 * in the topbar but are handy to glance at while looking at the
 * live feed:
 *
 *   - daemon version (lifelong fingerprint; useful when triaging a
 *     bug against a specific firmware),
 *   - WebRTC transport classification (LAN / Direct / Relay),
 *   - robot's reachable IP when ICE exposes it (for ad-hoc SSH),
 *   - instantaneous bitrate.
 *
 * Layout choice: a tiny two-column key/value grid. Each row carries
 * its own dim lowercase label (`ver`, `net`, `ip`, `rate`) so the
 * meaning of the value next to it is self-evident even on a first
 * glance — the previous "values only" stack read like an arbitrary
 * monospace dump (the user could tell something was diagnostic but
 * had to know the convention to map each line back to a concept).
 * Labels are intentionally short and lowercase so they don't
 * compete with the values for visual weight; the value column is
 * the bright one, the labels are the chrome.
 *
 * The column is still narrow (~16ch worst case with the longest
 * label + an IPv4) so it occupies a corner of the camera rather
 * than spanning the frame. The everyday "Wi-Fi vs USB" pill stays
 * in the topbar (`<IdentityChipBar>`) where the user actually
 * expects it.
 *
 * Reads daemon version from the shared `<DaemonStateProvider>` via
 * `useDaemonState()`. The host (`RobotSessionScreen`) is responsible
 * for mounting the provider; this overlay only consumes it.
 *
 * Pure consumer: no own state. The overlay is rendered side-by-side
 * with `<HeadJoystickOverlay>` inside the camera card; both are
 * absolute-positioned within the same 4:3 parent and occupy
 * opposite corners by design.
 */
import { Box, Stack, Typography } from '@mui/material';
import type { CSSProperties, ReactNode } from 'react';

import type { ConversationTransportInfo } from '@/features/conversation/engine/conversation-engine';
import { useDaemonState } from '@/features/daemon-state';
import { RADIUS, STATUS, TYPO } from '@/ui/design/tokens';

export interface CameraDebugOverlayProps {
  /** Live WebRTC transport snapshot (kind + bitrate + remote IP)
   *  forwarded from the session handle. `null` while ICE is still
   *  gathering; the lower portion of the overlay hides itself in
   *  that case so we don't flicker placeholder values on top of
   *  the video. */
  webrtcTransport: ConversationTransportInfo | null;
}

/**
 * Per-kind label + dot colour. Orange "relay" maps to STATUS.warning
 * - relayed audio is the one case where the user might want to
 * notice (added latency, the most likely path-quality issue we can
 * surface without measuring RTT ourselves).
 */
const KIND_META = {
  checking: { label: '', color: STATUS.info },
  lan: { label: 'LAN', color: STATUS.success },
  direct: { label: 'Direct', color: STATUS.info },
  relay: { label: 'Relay', color: STATUS.warning },
} as const;

const DOT_SIZE_PX = 6;

/** Shared colour tokens used across every row in the overlay so a
 *  future tone shift (e.g. higher contrast for outdoor demos) only
 *  has to touch one place. */
const LABEL_COLOR = 'rgba(255, 255, 255, 0.50)';
const VALUE_COLOR = 'rgba(255, 255, 255, 0.94)';

/**
 * Format `bps` as a kbps / Mbps string with one decimal until the
 * value gets fat enough to read cleanly without (≥ 10 Mbps or ≥ 100
 * kbps). Returns `''` for "no point displaying" so the caller can
 * just check truthiness.
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
 * Hide an mDNS `.local` hostname on LAN: the LAN dot already
 * carries the "same network" signal and the hostname isn't
 * directly SSH-friendly (a user copying it into a terminal would
 * still have to resolve it manually). Real IPv4/IPv6 values are
 * returned as-is - they're the whole point of the overlay.
 */
function formatRemoteIp(
  kind: ConversationTransportInfo['kind'],
  remoteIp: string | null,
): string {
  if (!remoteIp) return '';
  const normalised = remoteIp.toLowerCase();
  const isMdns =
    normalised.endsWith('.local') || normalised.endsWith('.local.');
  if (isMdns && kind === 'lan') return '';
  return remoteIp;
}

export default function CameraDebugOverlay({
  webrtcTransport,
}: CameraDebugOverlayProps) {
  // Read the daemon version straight from the shared context. While
  // the first round-trip hasn't landed it returns `null` - we render
  // an em-dash placeholder so the overlay's column width doesn't
  // jump as the value arrives a few hundred ms later.
  const { daemonVersion } = useDaemonState();
  const versionLabel = daemonVersion ? `v${daemonVersion}` : '—';

  // WebRTC section only renders once ICE has settled. During the
  // `checking` window the overlay shrinks to a single-line version
  // pill, which keeps the layout calm during the connection
  // handshake.
  const hasWebrtc =
    webrtcTransport !== null && webrtcTransport.kind !== 'checking';
  const meta = hasWebrtc ? KIND_META[webrtcTransport.kind] : null;
  const remoteIp = hasWebrtc
    ? formatRemoteIp(webrtcTransport.kind, webrtcTransport.remoteIp)
    : '';
  const bitrate = hasWebrtc ? formatBitrate(webrtcTransport.bps) : '';

  return (
    <Box
      // Pinned to the bottom-left of the camera frame. The head
      // joystick sits in the opposite corner (`bottom-right`) so
      // the two never compete for the same pixels - even on the
      // smallest viewport.
      sx={{
        position: 'absolute',
        bottom: 8,
        left: 8,
        // Same elevation as the joystick overlay so neither hides
        // the other when they happen to run into each other on
        // narrow viewports.
        zIndex: 2,
        // Solid-enough scrim that the text reads cleanly over the
        // brightest possible video frames (snow, white walls); the
        // backdrop blur softens whatever is behind so the overlay
        // doesn't look like a hard sticker. `backdrop-filter` is a
        // no-op on WKWebView pre-iOS 17.4 - the rgba background
        // alone stays legible on its own there.
        bgcolor: 'rgba(0, 0, 0, 0.55)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        color: VALUE_COLOR,
        borderRadius: `${RADIUS.sm}px`,
        border: '1px solid rgba(255, 255, 255, 0.1)',
        px: 1,
        py: 0.625,
        // The overlay must not eat clicks meant for the joystick or
        // future in-frame interactions; it is purely informational.
        pointerEvents: 'none',
        // Hard upper bound so a really long IP / future segment
        // doesn't push the overlay across the entire frame.
        maxWidth: 'calc(100% - 16px)',
      }}
      aria-label="Robot connection debug info"
    >
      {/* Two-column key/value grid. `auto 1fr` makes the label
          column shrink to the widest label and the value column
          fill the rest, so a long IPv4 doesn't push the labels
          off-axis. Tight row gap so the four rows read as one
          dense block rather than as a list. */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          columnGap: '8px',
          rowGap: '1px',
          alignItems: 'center',
        }}
      >
        <Row label="ver" title="Daemon version">
          <ValueText>{versionLabel}</ValueText>
        </Row>
        {hasWebrtc && meta && (
          <>
            <Row label="net" title="WebRTC transport kind">
              <Stack
                direction="row"
                alignItems="center"
                spacing={0.5}
                sx={{ minWidth: 0 }}
              >
                <Box
                  aria-hidden
                  sx={{
                    width: DOT_SIZE_PX,
                    height: DOT_SIZE_PX,
                    borderRadius: '50%',
                    bgcolor: meta.color,
                    flexShrink: 0,
                  }}
                />
                <ValueText>{meta.label}</ValueText>
              </Stack>
            </Row>
            {/* Each of IP / bitrate hides individually so the
                overlay stays as short as the available info allows
                (relay paths typically have no surfaceable IP). */}
            {remoteIp && (
              <Row label="ip" title="Robot IP">
                <ValueText>{remoteIp}</ValueText>
              </Row>
            )}
            {bitrate && (
              <Row label="rate" title="Bitrate">
                <ValueText style={{ opacity: 0.82 }}>{bitrate}</ValueText>
              </Row>
            )}
          </>
        )}
      </Box>
    </Box>
  );
}

/**
 * One row of the key/value grid. Renders as two grid cells: the
 * dim left-column label, and the bright right-column value
 * (whatever the caller passes - plain text via `<ValueText>` or a
 * richer composition like the `<Stack>` used for the dot + kind
 * label).
 *
 * Implemented as a fragment + two cells (NOT a wrapper) so the
 * parent grid actually sees the cells as direct children and can
 * align them against siblings from other rows.
 */
function Row({
  label,
  title,
  children,
}: {
  label: string;
  /** Tooltip-style hint for hover / long-press accessibility. */
  title: string;
  children: ReactNode;
}) {
  return (
    <>
      <Typography
        component="span"
        title={title}
        sx={{
          fontSize: TYPO.micro,
          fontFamily: 'monospace',
          lineHeight: 1.4,
          color: LABEL_COLOR,
          whiteSpace: 'nowrap',
          letterSpacing: '0.02em',
        }}
      >
        {label}
      </Typography>
      <Box sx={{ minWidth: 0 }}>{children}</Box>
    </>
  );
}

/**
 * Generic value cell. Centralises the monospace + colour + nowrap
 * triad so callers only have to pass the text, plus optional inline
 * style tweaks (e.g. the bitrate line is rendered slightly dimmer
 * since it's the most volatile signal and doesn't need to draw
 * the eye every second).
 */
function ValueText({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <Typography
      component="span"
      sx={{
        fontSize: TYPO.micro,
        fontFamily: 'monospace',
        lineHeight: 1.4,
        color: VALUE_COLOR,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </Typography>
  );
}
