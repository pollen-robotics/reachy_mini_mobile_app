/**
 * Tiny "signal bars" glyph that reads the live link QUALITY at a
 * glance - driven by latency (RTT), not topology and not bitrate.
 *
 * Why RTT (and not kind, not bitrate)
 * ───────────────────────────────────
 * An earlier version mapped the bars to the ICE `kind`
 * (lan=3 / direct=2 / relay=1). That conflated *topology* with
 * *quality*: a perfectly fast `direct` link was permanently capped at
 * 2 bars, so most real users would never see a full signal. Bitrate
 * is worse still - capped at 32 kbps and tracking speech activity
 * (≈0 in silence), it would flicker constantly.
 *
 * For a voice link the felt quality is LATENCY (+ loss), so the bars
 * now follow the rolling-min RTT via {@link linkQualityLevel}:
 *
 *   < 40 ms   ▮▮▮  excellent
 *   < 150 ms  ▮▮▯  good
 *   ≥ 150 ms  ▮▯▯  poor
 *
 * The connection TYPE (LAN / Direct / Relay) is a separate concern,
 * surfaced as its own little tag next to these bars by the topbar and
 * in the `<RobotInfoPanel>` - it answers "how am I reaching the
 * robot", not "how good is the link".
 *
 * When the platform doesn't expose RTT (iOS WKWebView),
 * `linkQualityLevel` falls back to the topology `kind` so the bars
 * still say something sensible. `kind === 'checking'` (or a `null`
 * kind) renders muted/empty bars; a fully absent transport renders
 * nothing.
 */
import { Box, Stack } from '@mui/material';

import { STATUS } from './tokens';

/**
 * Discrete signal level, 0 (measuring / empty) to 3 (excellent). The
 * mapping from raw RTT / topology lives in the feature layer
 * (`transport-monitor`'s `linkQualityLevel`); this primitive stays
 * dumb and just paints the bars for a level the caller hands it - so
 * `ui/design` keeps no dependency on `features`.
 */
export type LinkQuality = 0 | 1 | 2 | 3;

/** Lit-bar colour + human label per quality level. */
const LEVEL_META: Record<LinkQuality, { color: string | null; label: string }> = {
  0: { color: null, label: 'measuring…' },
  1: { color: STATUS.warning, label: 'poor' },
  2: { color: 'text.secondary', label: 'good' },
  3: { color: STATUS.success, label: 'excellent' },
};

/** Bar heights from shortest to tallest, in px. */
const BAR_HEIGHTS_PX = [5, 8, 11] as const;
const BAR_WIDTH_PX = 3;

interface LinkQualityBarsProps {
  /** Pre-computed signal level (0-3), via `linkQualityLevel`. */
  level: LinkQuality;
  /** Accessible label / tooltip; defaults to the level's word. */
  title?: string;
  /** Size multiplier applied to bar widths, heights, and the gap.
   *  Defaults to `1` (the compact topbar size). */
  scale?: number;
}

export function LinkQualityBars({ level, title, scale = 1 }: LinkQualityBarsProps) {
  const meta = LEVEL_META[level];
  const label = title ?? `Link quality: ${meta.label}`;

  return (
    <Stack
      role="img"
      aria-label={label}
      title={label}
      direction="row"
      spacing={`${2 * scale}px`}
      sx={{
        alignItems: 'flex-end',
        height: BAR_HEIGHTS_PX[BAR_HEIGHTS_PX.length - 1] * scale,
      }}
    >
      {BAR_HEIGHTS_PX.map((h, i) => {
        const lit = i < level;
        return (
          <Box
            key={i}
            sx={{
              width: BAR_WIDTH_PX * scale,
              height: h * scale,
              borderRadius: '1px',
              bgcolor: lit
                ? (meta.color ?? 'text.disabled')
                : theme =>
                    theme.palette.mode === 'dark'
                      ? 'rgba(255,255,255,0.18)'
                      : 'rgba(0,0,0,0.16)',
            }}
          />
        );
      })}
    </Stack>
  );
}
