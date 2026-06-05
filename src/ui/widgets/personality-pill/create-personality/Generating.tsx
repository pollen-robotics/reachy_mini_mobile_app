/**
 * Dedicated full-body view for the AI generation moment, replacing the old
 * "Generate button that morphs into a thin progress bar".
 *
 * ONE unified screen rather than a two-step generating-then-reveal flow: an
 * identity card that materialises in place. The persona STREAMS in field by
 * field - each slot (disc/monogram, name, tagline, voice) shows a skeleton
 * until its own value arrives, then swaps to the real thing (the name lands
 * first, so the monogram pops ~1s in). `ready` only flips the status line to
 * "Ready to talk" and drops the cancel affordance once the object is fully
 * committed + active. The overlay then closes on its own - the portrait keeps
 * baking and lands on the persistent personality band a moment later (a
 * second mini-reveal), so we never block on the ~1 min image.
 *
 * Purely presentational: all state/handlers come from props.
 */
import { Box, Button, CircularProgress, Skeleton, Stack, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import RecordVoiceOverRoundedIcon from '@mui/icons-material/RecordVoiceOverRounded';

import CookingMonogram from '@/ui/design/CookingMonogram';
import ShimmerText from '@/ui/design/ShimmerText';
import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';

const DISC_SIZE = 112;

// Geometry for the animated "ready" check: the ring draws first (its full
// circumference sweeps from offset → 0), then the check stroke draws in.
const READY_RING_C = 2 * Math.PI * 10;
const READY_CHECK_LEN = 16;

export interface CreatePersonalityGeneratingProps {
  /** False while the model is authoring (skeletons); true once the persona
   *  is known and committed (fields fill in, then the overlay closes). */
  ready: boolean;
  /** Authored persona fields (meaningful once `ready`). */
  name: string;
  tagline: string;
  voice: string;
  /** Back out of an in-flight generation (only while not `ready`). */
  onCancel: () => void;
}

export function CreatePersonalityGenerating({
  ready,
  name,
  tagline,
  voice,
  onCancel,
}: CreatePersonalityGeneratingProps) {
  // Drive each slot by the presence of its own value rather than the global
  // `ready`: as the persona streams in, the name lands first, then the
  // tagline, then the voice - each swapping its skeleton for the real value
  // the instant it arrives. (The disc always shows the shimmer monogram.)
  const hasName = name.trim().length > 0;
  const hasTagline = tagline.trim().length > 0;
  const hasVoice = voice.trim().length > 0;
  return (
    <Stack
      spacing={1.5}
      sx={{
        my: 'auto',
        mx: 'auto',
        alignItems: 'center',
        textAlign: 'center',
        width: '100%',
        maxWidth: 440,
        py: 3,
        // Nudge the WHOLE block (card + status + Cancel) down so the card reads
        // as optically centred: the disc only spills ~half its height above the
        // card while the status line + Cancel weigh more below it, so the auto-
        // centred block otherwise sits the card too high. Transform moves all
        // three together (a transform on the card alone wouldn't shift the rows
        // below it, since it doesn't affect layout flow).
        transform: 'translateY(44px)',
      }}
    >
      {/* Profile card: a contained "trading card" for the reveal. The avatar
          disc straddles the top edge (pulled up via the card's top padding +
          the disc's negative margin), giving the floating identity a frame.
          Status + Cancel live OUTSIDE the card, below. */}
      <Box
        sx={{
          position: 'relative',
          width: '100%',
          maxWidth: 320,
          // Room for the disc's top half to spill above the card.
          mt: `${DISC_SIZE / 2}px`,
        }}
      >
        <Box
          sx={{
            bgcolor: 'background.paper',
            border: t => `1px solid ${t.palette.divider}`,
            borderRadius: `${RADIUS.xl}px`,
            // Push content below the overlapping disc.
            pt: `${DISC_SIZE / 2 + 20}px`,
            pb: 3,
            px: 3,
          }}
        >
          {/* Cooking disc: white surface + light border (like the band's), with
              the shimmering monogram. Straddles the card's top edge. */}
          <Box
            sx={{
              position: 'absolute',
              top: 0,
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: DISC_SIZE,
              height: DISC_SIZE,
              borderRadius: '50%',
              bgcolor: 'background.paper',
              border: t => `1px solid ${t.palette.divider}`,
              overflow: 'hidden',
            }}
          >
            <CookingMonogram name={name} size={DISC_SIZE} shimmer />
          </Box>

          {/* Two grouped blocks with a generous gap between them, tight rhythm
              within: IDENTITY (kicker + name + tagline) then ATTRIBUTES (traits
              + voice). The hierarchy reads as "who they are" / "how they sound". */}
          <Stack spacing={2.5} sx={{ alignItems: 'center' }}>
            <Stack spacing={0.75} sx={{ alignItems: 'center', width: '100%' }}>
              <Typography
                sx={{
                  fontSize: TYPO.xs,
                  fontWeight: FONT_WEIGHT.semibold,
                  letterSpacing: '2px',
                  textTransform: 'uppercase',
                  color: 'text.secondary',
                }}
              >
                Meet
              </Typography>

              {hasName ? (
                <Typography
                  sx={{
                    fontSize: TYPO.hero,
                    fontWeight: FONT_WEIGHT.bold,
                    letterSpacing: '-0.5px',
                    lineHeight: 1.15,
                  }}
                >
                  {name.trim()}
                </Typography>
              ) : (
                // Match the name's rendered line box (TYPO.hero 1.5rem × lineHeight
                // 1.15 ≈ 28px) so the skeleton occupies the exact slot the text
                // will, with no vertical jump when it lands.
                <Skeleton variant="rounded" width={190} height={28} sx={{ borderRadius: 1.5 }} />
              )}

              {/* Tagline reserves a FIXED two-line box (the desc is always ~2
                  lines) so neither the skeleton-to-text swap nor a short/long
                  tagline ever changes this slot's height. */}
              <Box
                sx={{
                  width: '100%',
                  height: 44,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 0.5,
                }}
              >
                {hasTagline ? (
                  <Typography
                    sx={{
                      fontSize: TYPO.body,
                      lineHeight: 1.5,
                      color: 'text.secondary',
                      textAlign: 'center',
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}
                  >
                    {tagline.trim()}
                  </Typography>
                ) : (
                  <>
                    <Skeleton variant="rounded" width={228} height={14} sx={{ borderRadius: 1 }} />
                    <Skeleton variant="rounded" width={164} height={14} sx={{ borderRadius: 1 }} />
                  </>
                )}
              </Box>
            </Stack>

            <Stack spacing={1} sx={{ alignItems: 'center', width: '100%' }}>
              {hasVoice ? (
                <Stack
                  direction="row"
                  spacing={0.875}
                  sx={{
                    alignItems: 'center',
                    px: 1.5,
                    py: 0.5,
                    borderRadius: 999,
                    bgcolor: t => alpha(t.palette.text.primary, 0.05),
                  }}
                >
                  <RecordVoiceOverRoundedIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
                  <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary' }}>
                    {voice}
                  </Typography>
                </Stack>
              ) : (
                <Skeleton variant="rounded" width={116} height={28} sx={{ borderRadius: 999 }} />
              )}
            </Stack>
          </Stack>
        </Box>
      </Box>

      {/* Status slot: a fixed-height row so swapping the "cooking" line for the
          (taller) green "Ready to talk" tag never shifts the column. */}
      <Stack sx={{ height: 46, alignItems: 'center', justifyContent: 'center' }}>
        {ready ? (
          <Stack direction="row" spacing={1.125} sx={{ alignItems: 'center' }}>
            {/* Outlined success ring with a checkmark that draws in two beats:
                the ring sweeps closed first, then the tick strokes in. No tag,
                no fill - just the mark. */}
            <Box
              component="svg"
              viewBox="0 0 24 24"
              aria-hidden
              sx={{ width: 26, height: 26, flexShrink: 0, display: 'block' }}
            >
              <Box
                component="circle"
                cx={12}
                cy={12}
                r={10}
                sx={{
                  fill: 'none',
                  stroke: t => t.palette.success.main,
                  strokeWidth: 2,
                  strokeDasharray: READY_RING_C,
                  strokeDashoffset: READY_RING_C,
                  transformBox: 'fill-box',
                  transformOrigin: 'center',
                  transform: 'rotate(-90deg)',
                  '@keyframes readyRingDraw': { to: { strokeDashoffset: 0 } },
                  animation: 'readyRingDraw 0.5s ease-out forwards',
                  '@media (prefers-reduced-motion: reduce)': {
                    animation: 'none',
                    strokeDashoffset: 0,
                  },
                }}
              />
              <Box
                component="path"
                d="M6.8 12.4l3.4 3.4L17.4 8.2"
                sx={{
                  fill: 'none',
                  stroke: t => t.palette.success.main,
                  strokeWidth: 2,
                  strokeLinecap: 'round',
                  strokeLinejoin: 'round',
                  strokeDasharray: READY_CHECK_LEN,
                  strokeDashoffset: READY_CHECK_LEN,
                  '@keyframes readyCheckDraw': { to: { strokeDashoffset: 0 } },
                  animation: 'readyCheckDraw 0.32s 0.42s ease-out forwards',
                  '@media (prefers-reduced-motion: reduce)': {
                    animation: 'none',
                    strokeDashoffset: 0,
                  },
                }}
              />
            </Box>
            <Typography
              sx={{
                fontSize: TYPO.md,
                fontWeight: FONT_WEIGHT.semibold,
                color: 'success.main',
                lineHeight: 1,
              }}
            >
              Ready to talk
            </Typography>
          </Stack>
        ) : (
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
            <CircularProgress size={12} sx={{ color: 'text.disabled' }} />
            <ShimmerText sx={{ fontSize: TYPO.xs }}>
              Bringing your character to life…
            </ShimmerText>
          </Stack>
        )}
      </Stack>

      {/* Kept mounted (just hidden) once `ready` so removing it - and its
          stack gap - doesn't change the centred column's total height and
          jolt everything as the persona settles. */}
      <Button
        variant="text"
        color="primary"
        onClick={onCancel}
        disabled={ready}
        disableRipple
        aria-hidden={ready}
        sx={{
          textTransform: 'none',
          fontSize: TYPO.body,
          fontWeight: FONT_WEIGHT.medium,
          p: 0,
          minWidth: 0,
          textDecoration: 'underline',
          textUnderlineOffset: 3,
          visibility: ready ? 'hidden' : 'visible',
          '&:hover': { bgcolor: 'transparent', textDecoration: 'underline' },
        }}
      >
        Cancel
      </Button>
    </Stack>
  );
}
