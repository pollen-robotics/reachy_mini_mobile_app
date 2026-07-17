/**
 * Shared presentation bits for the first wake-up wizard: the headline,
 * the outlined primary button, the low-key "X doesn't work" link and the
 * per-step troubleshooting view.
 */

import type { ReactNode } from 'react';
import { Box, Button, Stack, Typography, alpha } from '@mui/material';
import ArrowBackIosNewIcon from '@mui/icons-material/ArrowBackIosNew';

import { openExternalUrl } from '@/shared/tauri/openUrl';
import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';
import { DISCORD_URL, FAQ_URL } from './constants';

/**
 * The 3D viz "stage" is a single persistent `ReachyViz` owned by the wizard
 * shell (it never unmounts across steps, so the canvas/model don't reload).
 * Each step draws its own overlays *on top* of that shared stage by rendering
 * a `<StageSlot>` as its first child: a transparent, same-footprint box that
 * lines up exactly over the persistent viz behind it. Only the camera step
 * fills the slot opaquely (covering the viz); other steps leave it see-through.
 */
export const STAGE_HEIGHT = 380;
// The 3D stage goes full-bleed (edge to edge), so this only caps how wide the
// whole wizard column gets on large/desktop viewports; on a phone the column is
// the screen width and the stage sticks to both edges.
export const STAGE_MAX_WIDTH = 640;
// Horizontal padding (theme spacing units) applied to the text zones. The stage
// cancels it with a negative margin so the canvas reaches the column edges
// while the copy keeps a comfortable gutter.
export const COLUMN_PX = 2;

// Reserved heights for the fixed step skeleton (see `StepScaffold`). Zones keep
// these heights regardless of their content/state, so swapping what's inside a
// zone never reflows its neighbours. The stage is top-anchored and the actions
// are bottom-anchored, so only the middle "breathes" - absorbed by the spacer.
export const HEADLINE_MIN_HEIGHT = 76;
export const FEEDBACK_MIN_HEIGHT = 108;
// Fixed (not min) height, sized for the tallest actions state (primary button
// + a secondary links row). The zone is bottom-docked and top-anchors its
// content, so the primary button keeps a constant Y whether or not the
// secondary links are shown - no more vertical jump between e.g. "Moving…" and
// "Yes, it moved". Big enough that the links state fits WITHIN it: the box also
// pins its height (minHeight:0 + flexShrink:0) so content can't grow it, so it
// must be tall enough to avoid clipping the links.
export const ACTIONS_HEIGHT = 116;
// Floor for the whole scaffold so it can't collapse on short viewports (the
// content column scrolls instead). Sum of the reserved zones + gaps.
export const SCAFFOLD_MIN_HEIGHT = 676;

export function StageSlot({ children, height = STAGE_HEIGHT }: { children?: ReactNode; height?: number }) {
  return (
    <Box
      sx={{
        position: 'relative',
        // Full-bleed: break out of the column's horizontal padding so the canvas
        // reaches the screen edges. Kept identical to the persistent viz box in
        // the shell so step overlays (hand, camera feed) stay pixel-aligned.
        width: `calc(100% + ${COLUMN_PX * 2 * 8}px)`,
        mx: -COLUMN_PX,
        height,
        // The stage itself is inert; the viz behind isn't interactive and the
        // step's real controls live below it. Individual overlays can re-enable
        // pointer events on themselves if they ever need to.
        pointerEvents: 'none',
      }}
    >
      {children}
    </Box>
  );
}

export function Headline({ title, caption }: { title: string; caption?: string }) {
  return (
    <Stack spacing={0.75} sx={{ alignItems: 'center', textAlign: 'center' }}>
      <Typography sx={{ fontSize: TYPO.xxl, fontWeight: FONT_WEIGHT.semibold }}>{title}</Typography>
      {caption ? (
        <Typography sx={{ fontSize: TYPO.md, color: 'text.secondary', maxWidth: 320, lineHeight: 1.5, px: 2 }}>
          {caption}
        </Typography>
      ) : null}
    </Stack>
  );
}

/**
 * Fixed skeleton shared by every wizard step. Four stacked zones with reserved
 * heights so the layout never jumps between steps or between a step's internal
 * states:
 *
 *   [ STAGE ]     top-anchored, fixed STAGE_HEIGHT  -> the persistent 3D viz sits here
 *   [ HEADLINE ]  title + caption, min height
 *   [ FEEDBACK ]  the variable middle slot (status, bars, slider…), reserved
 *   [ spacer ]    flex-grow, absorbs the leftover height
 *   [ ACTIONS ]   bottom-anchored CTA + secondary links, reserved
 *
 * Steps pass their content per zone; the stage overlay (if any) is drawn inside
 * the transparent `StageSlot` that lines up over the shell's persistent viz.
 */
export function StepScaffold({
  stageOverlay,
  title,
  caption,
  feedback,
  actions,
  centered = false,
  stageHeight = STAGE_HEIGHT,
}: {
  stageOverlay?: ReactNode;
  title: string;
  caption?: string;
  feedback?: ReactNode;
  actions?: ReactNode;
  /** Vertically center the content group (stage + headline + feedback) in the
   *  space above the actions instead of top-anchoring it. Used by steps whose
   *  stage isn't the shell's persistent (top-pinned) 3D viz - e.g. the camera
   *  step, which covers/hides the viz - so their content can sit centered.
   *  Actions stay docked at the bottom either way. */
  centered?: boolean;
  /** Override the reserved stage height. Steps that don't use the full-height
   *  persistent viz (e.g. the camera step, whose feed is a smaller 4:3 module)
   *  shrink it so the headline doesn't end up pushed far below the content. */
  stageHeight?: number;
}) {
  return (
    <Stack sx={{ width: '100%', height: '100%', minHeight: 0, alignItems: 'center' }}>
      {/* Top elastic gap (centered mode only): balances the bottom gap so the
          content group is vertically centered above the actions. */}
      {centered ? <Box sx={{ flex: 1, minHeight: 8 }} /> : null}

      <StageSlot height={stageHeight}>{stageOverlay}</StageSlot>

      <Box
        sx={{
          mt: 3,
          width: '100%',
          minHeight: HEADLINE_MIN_HEIGHT,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        }}
      >
        <Headline title={title} caption={caption} />
      </Box>

      {/* Reserve the feedback zone in top-anchored steps so swapping its content
          never reflows neighbours. In centered mode with no feedback we drop the
          zone entirely so the content group (stage + headline) truly centers. */}
      {feedback || !centered ? (
        <Box
          sx={{
            mt: 1,
            width: '100%',
            minHeight: FEEDBACK_MIN_HEIGHT,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {feedback}
        </Box>
      ) : null}

      {/* Elastic gap: soaks up the leftover height so the actions stay pinned to
          the bottom no matter how tall the zones above end up. */}
      <Box sx={{ flex: 1, minHeight: 8 }} />

      <Box
        sx={{
          width: '100%',
          maxWidth: 320,
          height: ACTIONS_HEIGHT,
          // Pin the height so it's authoritative: flex items default to
          // `min-height: auto` (won't shrink below their content), so a taller
          // "button + links" state would GROW this bottom-docked box and push
          // the button up. `minHeight: 0` overrides that and `flexShrink: 0`
          // stops it collapsing on short viewports - the box is always exactly
          // ACTIONS_HEIGHT, so the primary button's Y never moves.
          minHeight: 0,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          // Top-anchor: the primary button (always the first action) stays at a
          // constant Y across a step's states, so revealing the secondary links
          // below it never nudges it upward.
          justifyContent: 'flex-start',
          alignItems: 'center',
          gap: 1.5,
        }}
      >
        {actions}
      </Box>
    </Stack>
  );
}

export function PrimaryButton(props: React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="outlined"
      color="primary"
      fullWidth
      {...props}
      sx={{
        textTransform: 'none',
        fontSize: TYPO.md,
        fontWeight: FONT_WEIGHT.semibold,
        borderRadius: `${RADIUS.md}px`,
        py: 1.25,
        ...props.sx,
      }}
    />
  );
}

/** Underlined text link in primary colour. Used for the secondary
 *  "replay" / "X doesn't work" actions that sit under the main button. */
export function SubtleLink({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      onClick={onClick}
      disabled={disabled}
      sx={{
        textTransform: 'none',
        fontWeight: FONT_WEIGHT.medium,
        fontSize: TYPO.xs,
        color: 'primary.main',
        textDecoration: 'underline',
        '&:hover': { color: 'primary.main', opacity: 0.8, textDecoration: 'underline' },
      }}
    >
      {label}
    </Button>
  );
}

/** Low-key "X doesn't work" link that opens a step's troubleshooting view. */
export function TroubleLink({ label, onClick }: { label: string; onClick: () => void }) {
  return <SubtleLink label={label} onClick={onClick} />;
}

/** Thin separator between two inline links. */
export function LinkDivider() {
  return <Box sx={{ width: '1px', height: 14, bgcolor: 'divider' }} />;
}

function FooterLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      onClick={onClick}
      sx={{ textTransform: 'none', fontWeight: FONT_WEIGHT.medium, fontSize: TYPO.xs, color: 'primary.main' }}
    >
      {label}
    </Button>
  );
}

/** Per-step "something's wrong" view: numbered tips + FAQ/Discord footer. */
export function TroubleshootView({ title, tips, onBack }: { title: string; tips: string[]; onBack: () => void }) {
  return (
    <Stack spacing={2.5} sx={{ alignItems: 'center', width: '100%', my: 'auto' }}>
      <Typography sx={{ fontSize: TYPO.xxl, fontWeight: FONT_WEIGHT.semibold, textAlign: 'center' }}>{title}</Typography>

      <Stack spacing={1.25} sx={{ width: '100%', maxWidth: 360 }}>
        {tips.map((tip, i) => (
          <Stack
            key={i}
            direction="row"
            spacing={1.5}
            sx={{
              alignItems: 'flex-start',
              px: 2,
              py: 1.5,
              borderRadius: `${RADIUS.lg}px`,
              bgcolor: theme => alpha(theme.palette.text.primary, 0.03),
              border: theme => `1px solid ${theme.palette.divider}`,
            }}
          >
            <Typography sx={{ fontSize: TYPO.lg, fontWeight: FONT_WEIGHT.bold, color: 'primary.main', lineHeight: 1.4 }}>
              {i + 1}
            </Typography>
            <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary', lineHeight: 1.5 }}>{tip}</Typography>
          </Stack>
        ))}
      </Stack>

      <Box sx={{ width: '100%', maxWidth: 360, borderTop: theme => `1px solid ${theme.palette.divider}`, pt: 1.5 }}>
        <Stack direction="row" spacing={1} sx={{ justifyContent: 'center', flexWrap: 'wrap' }}>
          <FooterLink label="Check the FAQ ↗" onClick={() => void openExternalUrl(FAQ_URL)} />
          <FooterLink label="Discord support ↗" onClick={() => void openExternalUrl(DISCORD_URL)} />
        </Stack>
      </Box>

      <Box sx={{ width: '100%', maxWidth: 320 }}>
        <PrimaryButton startIcon={<ArrowBackIosNewIcon sx={{ fontSize: 14 }} />} onClick={onBack}>
          Back to test
        </PrimaryButton>
      </Box>
    </Stack>
  );
}
