/**
 * Reachy-style outlined robot icon, used in the bottom-nav
 * "Robot" tab.
 *
 * The actual artwork lives in `src/assets/robot--icon.svg` (so a
 * designer can edit it in Figma / Sketch and re-export without
 * touching any TSX). `vite-plugin-svgr`'s `?react` query loads it
 * as a React component; we wrap it in a `<Box>` purely to apply
 * the stroke-only style overrides via `sx`.
 *
 * Why a wrapper at all
 * ────────────────────
 * - The source SVG draws on a 370×370 viewBox with `stroke-width=5`,
 *   which becomes invisible (~0.4 CSS px) when rendered at 30 px
 *   nav-icon size. `vector-effect: non-scaling-stroke` + a 1.6 px
 *   stroke override gives a crisp outline at any rendered size.
 * - The svgr-generated component is built with `icon: true`, so it
 *   already renders at `1em × 1em` and inherits `font-size`. Sizing
 *   it from the parent (`fontSize: 30px`) "just works".
 * - `currentColor` is propagated automatically: we set it on the
 *   `stroke` attributes inside the SVG file itself, so a
 *   selected/inactive nav state colour change cascades for free.
 */
import { Box, type BoxProps } from "@mui/material";

import RobotSvg from "@/assets/robot--icon.svg?react";

const STROKE_DEFAULTS = {
  // Force `fill: none` here (overrides any browser default) so the
  // SVG renders as pure outline. The source SVG already declares
  // `stroke="currentColor"`, but we re-assert the cascade target
  // here for safety against future stylesheet changes.
  fill: "none",
  // Keep the rendered stroke crisp regardless of the SVG's
  // intrinsic 370×370 → 30 px scale-down.
  "& path, & rect, & ellipse, & line": {
    vectorEffect: "non-scaling-stroke",
    strokeWidth: 1.6,
  },
} as const;

export default function RobotIcon(props: BoxProps) {
  return (
    <Box
      component={RobotSvg}
      {...props}
      sx={[
        STROKE_DEFAULTS,
        ...(Array.isArray(props.sx) ? props.sx : [props.sx ?? false]),
      ]}
    />
  );
}
