/**
 * Outlined "move in any direction" glyph: a four-arrow plus
 * sign rendered with strokes only.
 *
 *      ▲
 *      │
 *   ◀──┼──▶
 *      │
 *      ▼
 *
 * Used as the centre glyph of the head-control joystick thumb,
 * where it advertises "you can drag this in any direction".
 * MUI ships `OpenWithIcon` (filled) and `OpenWithOutlinedIcon`,
 * but the outlined variant uses thinner strokes and reads
 * inconsistently next to the rest of the app's hand-drawn
 * outlined glyphs (`MicIcon`, `AppsIcon`, `RobotIcon`). This
 * version uses the same `1.8 px` round-capped stroke as those
 * siblings so the design language stays unified.
 *
 * Why we force fill/stroke via `sx` (and not the SVG attributes)
 * ──────────────────────────────────────────────────────────────
 * Same dance as the other custom outlined icons: MUI's
 * `SvgIcon` ships `fill: currentColor` via a CSS class, which
 * silently overrides any `fill="none"` SVG attribute (presentation
 * attributes have specificity 0). Painting fill/stroke through
 * `sx` produces a higher-specificity class and wins the cascade.
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
 * Geometry inside a 24×24 viewBox: four independent arrows
 * radiating from a hollow centre (10 × 10 gap, from `7` to `17`
 * on each axis). Each arrow has a 5-unit stem from the inner
 * boundary out to the tip and a `V` arrowhead pointing outward.
 *
 *        ▲
 *        │
 *  ◀─────┼─────▶    (centre is empty, no crossing lines)
 *        │
 *        ▼
 *
 * The hollow centre keeps the four arrows visually separate.
 * Previous drafts had a smaller gap and shorter stems, which
 * read as a `+` with decorations rather than four distinct
 * arrows; pushing the tips out to coordinates `2` / `22` and
 * the stem origin in to `7` / `17` makes the arrows long
 * enough to read at the joystick thumb's small render size.
 */
export default function MoveIcon(props: SvgIconProps) {
  return (
    <SvgIcon
      viewBox="0 0 24 24"
      {...props}
      sx={[
        STROKE_DEFAULTS,
        ...(Array.isArray(props.sx) ? props.sx : [props.sx ?? false]),
      ]}
    >
      {/* Top arrow: stem (12,7) → (12,2), arrowhead at (12,2).
          Starts further from the centre (`7` vs the earlier `8`)
          and reaches closer to the edge (`2` vs `4`), so the
          stem is longer and the four arrows feel like they
          breathe out of a wider hollow centre. */}
      <line x1="12" y1="7" x2="12" y2="2" />
      <polyline points="8 5 12 2 16 5" />
      {/* Bottom arrow: stem (12,17) → (12,22), arrowhead at (12,22). */}
      <line x1="12" y1="17" x2="12" y2="22" />
      <polyline points="8 19 12 22 16 19" />
      {/* Left arrow: stem (7,12) → (2,12), arrowhead at (2,12). */}
      <line x1="7" y1="12" x2="2" y2="12" />
      <polyline points="5 8 2 12 5 16" />
      {/* Right arrow: stem (17,12) → (22,12), arrowhead at (22,12). */}
      <line x1="17" y1="12" x2="22" y2="12" />
      <polyline points="19 8 22 12 19 16" />
    </SvgIcon>
  );
}
