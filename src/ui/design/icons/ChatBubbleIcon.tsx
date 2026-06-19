/**
 * Outlined speech-bubble icon for the Conversation nav tab.
 *
 *   ╭───────╮
 *   │       │   ← rounded bubble (the message)
 *   ╰──╮ ╭──╯
 *      ╰─╯       ← tail
 *
 * Hand-drawn 24×24 path that's strictly outline (no filled
 * regions) so it matches `MicIcon` / `AppsIcon` in the bottom
 * nav - same `1.8 px` stroke weight, same outline-only treatment,
 * same 24×24 viewBox.
 *
 * Why we force fill/stroke via `sx` (and not the SVG attributes):
 * MUI's `SvgIcon` ships `fill: currentColor` on `.MuiSvgIcon-root`,
 * which (higher cascade specificity than SVG presentation
 * attributes) would override a `fill="none"` prop. Painting the
 * stroke defaults through `sx` wins the cascade. The defaults are
 * appended FIRST so caller `sx` can still override.
 */
import { SvgIcon, type SvgIconProps } from "@mui/material";

const STROKE_DEFAULTS = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export default function ChatBubbleIcon(props: SvgIconProps) {
  return (
    <SvgIcon
      viewBox="0 0 24 24"
      {...props}
      sx={[
        STROKE_DEFAULTS,
        ...(Array.isArray(props.sx) ? props.sx : [props.sx ?? false]),
      ]}
    >
      <path d="M4 12a8 7 0 0 1 8-7 8 7 0 0 1 8 7 8 7 0 0 1-8 7 9 9 0 0 1-3-.5L5.5 20l.7-3A6.7 6.7 0 0 1 4 12Z" />
    </SvgIcon>
  );
}
