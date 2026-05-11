/**
 * Outlined apps icon, used in the bottom-nav "Apps" tab.
 *
 *   ┌─┐ ┌─┐
 *   └─┘ └─┘    ← 4 rounded squares in a 2 x 2 grid
 *   ┌─┐ ┌─┐
 *   └─┘ └─┘
 *
 * Hand-drawn 24×24 path that's strictly outline (no filled
 * regions) so it sits next to `MicIcon` and `RobotIcon` without
 * a visual jolt. MUI ships `AppsOutlinedIcon`, but its path is
 * identical to the filled `AppsIcon` (9 filled squares) - the
 * "Outlined" suffix is a no-op there. The previous nav used
 * `GridViewOutlinedIcon` which is genuinely outlined but draws
 * 4 filled-look-alike rectangles with thin internal partitions
 * that read as a busy grid; this version trades that for 4
 * cleanly separated squares with the same `1.8 px` stroke
 * weight as `MicIcon` for visual rhythm consistency across the
 * three nav glyphs.
 *
 * Why we force fill/stroke via `sx` (and not the SVG attributes)
 * ──────────────────────────────────────────────────────────────
 * Same dance as `MicIcon` and `RobotIcon`: MUI's `SvgIcon`
 * ships `fill: currentColor` via a CSS class, which silently
 * overrides any `fill="none"` SVG attribute (presentation
 * attributes have specificity 0). Setting fill / stroke
 * through `sx` produces a class with higher specificity than
 * the default and wins the cascade.
 */
import { SvgIcon, type SvgIconProps } from "@mui/material";

const STROKE_DEFAULTS = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/**
 * Geometry. Four 7×7 rounded squares laid out symmetrically in
 * the 24×24 viewBox with a 4 px gap between adjacent squares
 * and a 3 px outer padding (3 + 7 + 4 + 7 + 3 = 24).
 *
 *   3 ── 10 ── 14 ── 21 ── 24    (x boundaries)
 *   ┌─────┐    ┌─────┐
 *   │     │    │     │
 *   └─────┘    └─────┘
 *   ┌─────┐    ┌─────┐
 *   │     │    │     │
 *   └─────┘    └─────┘
 */
export default function AppsIcon(props: SvgIconProps) {
  return (
    <SvgIcon
      viewBox="0 0 24 24"
      {...props}
      sx={[
        STROKE_DEFAULTS,
        ...(Array.isArray(props.sx) ? props.sx : [props.sx ?? false]),
      ]}
    >
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </SvgIcon>
  );
}
