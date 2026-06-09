/**
 * Identity block rendered on the left side of the session top bar.
 *
 * Single-line layout, left-aligned, no avatar. Bordered pills sit to
 * the right of the name, each icon/glyph + text:
 *
 *   Reachy_mini  [⌁ Lite]      [▮▮▮ 0 ms]
 *   Reachy_mini  [≋ Wireless]  [▮▮▮ 38 ms]
 *
 *   - variant tag   : USB / Wi-Fi icon + the product SKU it maps onto
 *                     (`Lite` wired / `Wireless` onboard). STABLE
 *                     identity, not a health signal. Always present.
 *   - latency tag   : RTT-driven signal bars + the exact `… ms` value
 *                     (see `<LinkQualityBars>`). ALWAYS shown - an
 *                     unknown / LAN-instant link reads as `0 ms` - so
 *                     it's a permanent "is my link fast" glance.
 *
 * While the link is (re)connecting a transient toned mini-spinner pill
 * appears (see `resolveTypeTag`). The routing topology label
 * (`LAN` / `Direct` / `Relay`) was dropped as noise next to latency.
 *
 * Separate pills (not one grouped strip) were chosen so each module
 * reads as its own discrete fact.
 *
 * The short hardware id used to live here (`#abc12`) but it's now
 * surfaced in full inside the on-demand `<RobotInfoPanel>` (opened
 * via the `ⓘ` button), where the complete identifier is copyable -
 * the topbar is for everyday-grade identity, the panel for the
 * technical fingerprint.
 *
 * Debug-grade detail (WebRTC kind label, IP, bitrate, exact latency,
 * daemon version) all live in the on-demand `<RobotInfoPanel>` opened
 * from the `ⓘ` button in the topbar's right action cluster.
 *
 * Pure presentational: the host (`RobotSessionScreen`) owns the
 * power-off button and any other actions; this component only
 * renders identity.
 */
import { CircularProgress, Stack, Typography } from '@mui/material';

import type { ConversationTransportKind } from '@/features/conversation/engine/conversation-engine';
import type { SessionPhase } from '@/features/robot-session/useRobotSession';
import { linkQualityLevel } from '@/features/robot-session/transport-monitor';
import { LinkQualityBars } from '@/ui/design/LinkQualityBars';
import { MetaPill, TagLabel, VariantTag } from '@/ui/design/MetaPill';
import { FONT_WEIGHT, STATUS, TYPO } from '@/ui/design/tokens';

interface TypeTag {
  label: string;
  /** Border + text colour. Omitted = neutral (divider / text.secondary). */
  tone?: string;
  /** Pulse a leading dot - reserved for in-flight (info) states. */
  pulse?: boolean;
}

/**
 * Resolve the transient link-state tag (its own pill). We no longer
 * surface the routing topology (`LAN` / `Direct` / `Relay`) - that was
 * noise next to the always-on latency read - so this is now purely the
 * in-flight lifecycle cue:
 *
 *   1. Connecting / Reconnecting - in-flight (info, mini spinner).
 *   2. Otherwise                 - null (only the latency pill shows).
 */
function resolveTypeTag(phase: SessionPhase): TypeTag | null {
  if (phase === 'bringing-up') return { label: 'Connecting', tone: STATUS.info, pulse: true };
  if (phase === 'reacquiring') return { label: 'Reconnecting', tone: STATUS.info, pulse: true };
  return null;
}

/**
 * Format the rolling-min RTT as a compact, integer `… ms` tag value.
 * Always returns a value: an unknown / not-yet-measured RTT reads as
 * `0 ms` so the latency pill is a permanent fixture in the topbar.
 */
function formatLatencyTag(rttMs: number | null): string {
  const ms = rttMs !== null && Number.isFinite(rttMs) && rttMs > 0 ? Math.round(rttMs) : 0;
  return `${ms} ms`;
}

interface IdentityChipBarProps {
  robotName: string;
  /** Physical transport string from the robot's central listing
   *  (`wifi` / `usb` / …). Rendered via `<TransportChip>` (icon
   *  only) to the right of the robot name. Stable identity signal
   *  (desktop-tray daemon vs autonomous robot), kept always-on but
   *  muted. */
  transport: string;
  /** Live WebRTC candidate-pair classification. Drives the link-type
   *  tag (LAN / Direct / Relay) and the quality bars. `null` (no
   *  transport info yet) hides them. */
  linkKind: ConversationTransportKind | null;
  /** Rolling-min RTT (ms) on the selected pair, or `null` when the
   *  platform doesn't expose it. Drives the quality bars + the
   *  latency tag value. */
  linkRttMs: number | null;
  /** Current session lifecycle phase. Drives the transient
   *  Connecting / Reconnecting state of the link-type tag. */
  sessionPhase: SessionPhase;
}

/** Mini spinner for in-flight (Connecting / Reconnecting) tags - reads
 *  as "working on it / temporary" better than a static dot. */
function TagSpinner({ color }: { color: string }) {
  return <CircularProgress size={11} thickness={5.5} sx={{ color, flexShrink: 0 }} />;
}

export default function IdentityChipBar({
  robotName,
  transport,
  linkKind,
  linkRttMs,
  sessionPhase,
}: IdentityChipBarProps) {
  const typeTag = resolveTypeTag(sessionPhase);
  // Latency is now a permanent indicator: always shown, even at `0 ms`
  // (unknown / LAN-instant). Reads as a stable "link health" glance.
  const latencyText = formatLatencyTag(linkRttMs);

  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0, flex: 1 }}>
      <Typography
        sx={{
          minWidth: 0,
          fontSize: TYPO.md,
          fontWeight: FONT_WEIGHT.bold,
          color: 'text.primary',
          letterSpacing: '-0.1px',
          lineHeight: 1.2,
          // Name truncates with an ellipsis when the row is too
          // narrow so the meta pills stay visible to its right.
          flexShrink: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          // Always show the name with a leading capital, without
          // touching the rest (so "reachy_mini" -> "Reachy_mini",
          // not "Reachy_Mini" like `capitalize` would do).
          '&::first-letter': { textTransform: 'uppercase' },
        }}
        noWrap
      >
        {robotName}
      </Typography>

      {/* Meta pills to the RIGHT of the name, each icon/glyph + text:
            [⌁ Lite]  [▮▮▮ 38 ms]
          plus a transient [spinner] while the link is (re)connecting.
          The host's own toolbar owns the right edge for the power-off
          button. */}
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexShrink: 0 }}>
        <VariantTag transport={transport} />
        <MetaPill>
          <LinkQualityBars
            level={linkQualityLevel(linkRttMs, linkKind ?? 'checking')}
            title={`Link quality (${latencyText})`}
          />
          <TagLabel>{latencyText}</TagLabel>
        </MetaPill>
        {typeTag && typeTag.pulse && typeTag.tone && (
          // In-flight (Connecting / Reconnecting): just a mini spinner, no
          // label - the toned spinner already reads as "working on it".
          // Always rendered LAST, after the transport + latency tags.
          <MetaPill tone={typeTag.tone}>
            <TagSpinner color={typeTag.tone} />
          </MetaPill>
        )}
      </Stack>
    </Stack>
  );
}
