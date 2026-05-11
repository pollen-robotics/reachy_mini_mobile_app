/**
 * Outlined microphone icon, shared across the voice surfaces.
 *
 *   ╭─╮
 *   │ │   ← capsule (mic body)
 *   ╰─╯
 *    │    ← stem
 *  ⌣⌣⌣   ← arc (acoustic field) + base
 *
 * Hand-drawn 24×24 path that's strictly outline (no filled
 * regions) so it stays consistent with the rest of the
 * outlined nav icons. MUI ships `MicOutlinedIcon`, but its path
 * mixes filled and stroked regions which read as semi-filled
 * on small targets - this version uses `stroke` exclusively
 * for an unambiguous "outline glyph" look.
 *
 * Why we force fill/stroke via `sx` (and not the SVG attributes)
 * ──────────────────────────────────────────────────────────────
 * MUI's `SvgIcon` ships with `fill: currentColor` on its root
 * `.MuiSvgIcon-root` CSS rule. SVG presentation attributes have
 * a specificity of 0 in cascade order, so passing `fill="none"`
 * as a prop is silently overridden by the class - the previous
 * iteration of this component looked filled at runtime even
 * though the JSX clearly said `fill="none"`. Painting the same
 * properties via `sx` (which compiles to a class with higher
 * specificity than the default one) wins the cascade.
 *
 * The default sx is appended FIRST, so caller `sx` can still
 * override (e.g. to bump stroke width for a giant render).
 *
 * Wrapped in MUI's `SvgIcon` so it inherits font-driven sizing
 * (`fontSize: 30` on the bottom-nav `MuiSvgIcon-root` selector
 * applies here too) and `currentColor` ink propagation
 * (selected vs. inactive nav state, hover, etc.).
 */
import { SvgIcon, type SvgIconProps } from "@mui/material";

const STROKE_DEFAULTS = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export default function MicIcon(props: SvgIconProps) {
  return (
    <SvgIcon
      viewBox="0 0 24 24"
      {...props}
      sx={[
        STROKE_DEFAULTS,
        ...(Array.isArray(props.sx) ? props.sx : [props.sx ?? false]),
      ]}
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="8" y1="22" x2="16" y2="22" />
    </SvgIcon>
  );
}
