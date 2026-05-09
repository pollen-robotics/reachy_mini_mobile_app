/**
 * Generic horizontal steps indicator with an integrated progress
 * bar running BEHIND the steps.
 *
 *   ●━━━━━━━━━●━━━━━━━━━○━━━━━━━━━○
 *   Link       Session    Wake-up    Ready
 *
 * - Completed steps render a checkmark (`pop-in` animation) on the
 *   filled (green) bar.
 * - The current step pulses gently and shows a tiny dot inside.
 * - Future steps stay neutral on the unfilled track.
 *
 * Ported from the desktop app's `StepsProgressIndicator` so the two
 * clients feel built by the same hand. Colours hooked into MUI
 * palette (`theme.palette.mode`) instead of the desktop's
 * `useAppPalette()` so we get dark-mode automatically.
 */
import { Box, Typography, keyframes, useTheme } from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';

import { DURATION, FONT_WEIGHT, RADIUS, STATUS, TYPO } from './tokens';

export interface StepsProgressStep {
  /** Stable id used as React key. */
  id: string;
  /** Short uppercase label rendered under the dot (≤ ~10 chars). */
  label: string;
}

export interface StepsProgressIndicatorProps {
  steps: StepsProgressStep[];
  /** 0-indexed current step. Steps before this index are rendered as
   *  completed. Steps after are pending. */
  currentStep: number;
  /** Optional explicit progress percentage (0-100). When omitted the
   *  bar is computed from `currentStep / (steps.length - 1)`. */
  progress?: number;
  /** When `true` the active step uses the primary tint instead of
   *  the neutral active grey. Useful to signal "we're actively
   *  recovering" (e.g. a retry attempt) vs the standard happy path. */
  accent?: boolean;
}

// Pulse animation for current step (matches desktop tuning)
const pulse = keyframes`
  0%, 100% {
    transform: scale(1);
    opacity: 1;
  }
  50% {
    transform: scale(0.92);
    opacity: 0.8;
  }
`;

// Checkmark pop-in animation
const popIn = keyframes`
  0%   { transform: scale(0); }
  60%  { transform: scale(1.15); }
  100% { transform: scale(1); }
`;

// Fixed visual dimensions, matched to the desktop component.
const BAR_HEIGHT_PX = 2;
const STEP_SIZE_PX = 34;
const BORDER_WIDTH_PX = 2.5;

export default function StepsProgressIndicator({
  steps,
  currentStep,
  progress: progressOverride,
  accent = false,
}: StepsProgressIndicatorProps) {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';

  // Resolve progress: explicit override wins, otherwise derive from
  // step index (linear). Clamp to [0, 100].
  const computed =
    steps.length > 1 ? (currentStep / (steps.length - 1)) * 100 : 0;
  const progress = Math.max(
    0,
    Math.min(100, progressOverride ?? computed),
  );

  // Local greys + the success-green for the completed bar / dots.
  // Sourced from the design tokens (STATUS.success) and from the
  // theme palette (background.paper/default for the "floating
  // border" trick that hides the bar behind the dot).
  const bgColor = isDark ? '#1a1a1a' : theme.palette.background.paper;
  const trackColor = isDark ? '#2a2a2a' : theme.palette.divider;
  const fillColor = STATUS.success;
  const activeColor = accent
    ? theme.palette.primary.main
    : isDark
      ? '#a3a3a3'
      : '#737373';
  const inactiveLabelColor = isDark ? '#525252' : '#a3a3a3';

  const barInset = STEP_SIZE_PX / 2;

  return (
    <Box
      sx={{
        position: 'relative',
        width: '100%',
        height: STEP_SIZE_PX + 22,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
      }}
    >
      {/* Progress bar container - inset by half a step on each side
          so the bar visually starts and ends at the centre of the
          first / last dot. */}
      <Box
        sx={{
          position: 'absolute',
          top: (STEP_SIZE_PX - BAR_HEIGHT_PX) / 2,
          left: barInset,
          right: barInset,
          height: BAR_HEIGHT_PX,
        }}
      >
        {/* Track (background) */}
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            bgcolor: trackColor,
            borderRadius: BAR_HEIGHT_PX / 2,
          }}
        />
        {/* Fill (progress, animated) */}
        <Box
          sx={{
            position: 'absolute',
            top: 0,
            left: 0,
            bottom: 0,
            width: `${progress}%`,
            bgcolor: fillColor,
            borderRadius: BAR_HEIGHT_PX / 2,
            transition: `width ${DURATION.slow}ms ease-out`,
          }}
        />
      </Box>

      {/* Steps row */}
      <Box
        sx={{
          position: 'relative',
          width: '100%',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
        }}
      >
        {steps.map((step, index) => {
          const isCompleted = index < currentStep;
          const isCurrent = index === currentStep;
          return (
            <Box
              key={step.id}
              sx={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 0.5,
              }}
            >
              {/* Outer disc - same colour as the page background so
                  it visually punches a hole in the progress bar
                  ("floating dot" effect). */}
              <Box
                sx={{
                  width: STEP_SIZE_PX,
                  height: STEP_SIZE_PX,
                  borderRadius: RADIUS.circle,
                  bgcolor: bgColor,
                  border: `${BORDER_WIDTH_PX}px solid ${bgColor}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  position: 'relative',
                  zIndex: 1,
                }}
              >
                {/* Inner circle - 2 px ring + status icon. The
                    pulsing animation lives here so the ring breathes
                    while the outer disc stays still (cleaner). */}
                <Box
                  sx={{
                    width: STEP_SIZE_PX - BORDER_WIDTH_PX * 2,
                    height: STEP_SIZE_PX - BORDER_WIDTH_PX * 2,
                    borderRadius: RADIUS.circle,
                    bgcolor: bgColor,
                    border: `2px solid ${
                      isCompleted
                        ? fillColor
                        : isCurrent
                          ? activeColor
                          : trackColor
                    }`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: `all ${DURATION.slow}ms ease`,
                    animation: isCurrent
                      ? `${pulse} 2s ease-in-out infinite`
                      : 'none',
                  }}
                >
                  {isCompleted ? (
                    <CheckIcon
                      sx={{
                        fontSize: TYPO.sm,
                        color: fillColor,
                        animation: `${popIn} 0.35s ease-out`,
                      }}
                    />
                  ) : isCurrent ? (
                    <Box
                      sx={{
                        width: 5,
                        height: 5,
                        borderRadius: RADIUS.circle,
                        bgcolor: activeColor,
                      }}
                    />
                  ) : null}
                </Box>
              </Box>

              {/* Label */}
              <Typography
                sx={{
                  fontSize: TYPO.tiny,
                  fontWeight: isCurrent
                    ? FONT_WEIGHT.semibold
                    : isCompleted
                      ? FONT_WEIGHT.medium
                      : FONT_WEIGHT.regular,
                  color: isCompleted
                    ? fillColor
                    : isCurrent
                      ? activeColor
                      : inactiveLabelColor,
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  transition: `all ${DURATION.slow}ms ease`,
                  userSelect: 'none',
                }}
              >
                {step.label}
              </Typography>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
