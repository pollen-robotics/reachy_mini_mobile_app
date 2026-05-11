/**
 * Uniform card frame used by every section on the Robot tab.
 *
 *   ┌────────────────────────────────────────────────────┐
 *   │ TITLE      subtitle (optional)              [⋯]   │  ← header strip
 *   ├────────────────────────────────────────────────────┤  ← divider
 *   │                                                    │
 *   │              <section content>                     │
 *   │                                                    │
 *   └────────────────────────────────────────────────────┘
 *
 * Why this exists
 * ───────────────
 * The Robot tab used to be a stack of three visually-different
 * blocks: a camera card with a heavy shadow, two side-by-side
 * audio cards with no header, a log console with its own custom
 * header inside the chrome. Discoverability suffered (no
 * consistent label pattern), the chrome was inconsistent (border
 * weights / radii / paper bgs differed), and there was no
 * canonical place to attach per-section actions (copy, fullscreen,
 * snapshot, ...) - the log copy button was buried inside the
 * console itself.
 *
 * `<RobotPanel>` enforces ONE chrome, ONE header anatomy across
 * every section so a glance at the tab gives the user "I'm seeing
 * three sections, each with a label and an optional sub-label
 * explaining what it is and what I can do with it". New sections
 * (settings, battery, shortcuts, ...) drop in without re-deciding
 * the visual contract.
 *
 * Props
 * ─────
 *   - `title`    : short uppercase label, e.g. "CAMERA" / "AUDIO"
 *   - `subtitle` : optional descriptive line beside the title
 *                  (e.g. "view from Reachy + head joystick"). Truncates
 *                  with ellipsis on narrow screens.
 *   - `actions`  : optional ReactNode for the right edge of the
 *                  header (typically `IconButton`s for per-section
 *                  actions).
 *   - `noBodyChrome` : when true the body has no padding nor inner
 *                     bg; the child draws its own surface (used by
 *                     the camera frame and the log console which
 *                     both want full-bleed control of their inner
 *                     pixels). Defaults to false (= sensible
 *                     padding for inline content like sliders).
 */
import { Box, Stack, Typography } from "@mui/material";
import type { SxProps, Theme } from "@mui/material/styles";
import type { ReactNode } from "react";

import { FONT_WEIGHT, RADIUS, TYPO } from "@/ui/design/tokens";

interface RobotPanelProps {
  /**
   * Header label. Optional - when omitted the panel renders
   * without its top header strip, useful for sections where the
   * content carries its own affordance (e.g. the camera frame
   * with a `CameraBadge` overlay) and an outer label would feel
   * redundant.
   */
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  noBodyChrome?: boolean;
  /**
   * Forwarded onto the panel root. Used by hosts that want the
   * panel to participate in a flex column (typical pattern: pass
   * `{ flex: 1, minHeight: 0 }` to make the LOGS panel fill the
   * leftover vertical space inside the Robot tab without breaking
   * the chrome). Anything else (border, bg, padding) should still
   * be configured via the dedicated props - this is the escape
   * hatch for sizing only.
   */
  sx?: SxProps<Theme>;
}

const HEADER_MIN_HEIGHT = 32;

export default function RobotPanel({
  title,
  subtitle,
  actions,
  children,
  noBodyChrome = false,
  sx,
}: RobotPanelProps) {
  return (
    <Box
      sx={[
        (theme) => ({
          display: "flex",
          flexDirection: "column",
          borderRadius: `${RADIUS.lg}px`,
          border: `1px solid ${theme.palette.divider}`,
          bgcolor: theme.palette.background.paper,
          // `overflow: hidden` so the inner content respects the
          // parent's bottom radius (camera video, log scroll, etc.).
          overflow: "hidden",
        }),
        ...(Array.isArray(sx) ? sx : [sx ?? false]),
      ]}
    >
      {title !== undefined && (
        <Stack
          direction="row"
          alignItems="center"
          spacing={1}
          sx={(theme) => ({
            flexShrink: 0,
            minHeight: HEADER_MIN_HEIGHT,
            px: 1.25,
            py: 0.5,
            borderBottom: `1px solid ${theme.palette.divider}`,
            // Subtle tint so the header strip reads as "chrome" vs
            // the content below. Tuned to be barely visible on
            // light, slightly more present on dark (where pure
            // paper/paper has very little contrast).
            bgcolor:
              theme.palette.mode === "dark"
                ? "rgba(255,255,255,0.03)"
                : "rgba(0,0,0,0.02)",
          })}
        >
          <Typography
            sx={{
              fontSize: TYPO.micro,
              fontWeight: FONT_WEIGHT.semibold,
              color: "text.secondary",
              textTransform: "uppercase",
              letterSpacing: "0.5px",
              whiteSpace: "nowrap",
              flexShrink: 0,
              lineHeight: 1.2,
            }}
          >
            {title}
          </Typography>

          {subtitle ? (
            <Typography
              title={subtitle}
              sx={{
                flex: 1,
                minWidth: 0,
                fontSize: TYPO.micro,
                color: "text.secondary",
                opacity: 0.65,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                lineHeight: 1.2,
              }}
            >
              {subtitle}
            </Typography>
          ) : (
            <Box sx={{ flex: 1 }} />
          )}

          {actions && (
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.25,
                flexShrink: 0,
              }}
            >
              {actions}
            </Box>
          )}
        </Stack>
      )}

      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          // Padding is only applied for "inline content" sections
          // (e.g. audio sliders). Surfaces that draw their own
          // pixels edge-to-edge (camera video, log terminal) opt
          // out via `noBodyChrome`.
          ...(noBodyChrome ? {} : { p: 1.25 }),
        }}
      >
        {children}
      </Box>
    </Box>
  );
}
