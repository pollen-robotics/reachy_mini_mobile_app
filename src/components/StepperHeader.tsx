/**
 * Thin wrapper around MUI's Stepper that matches the desktop app's visual
 * treatment (alternative-label, muted idle color, accent active, green
 * completed). Kept here so every multi-step screen on mobile shares the
 * exact same affordance.
 */

import { Stepper, Step, StepLabel, useTheme } from '@mui/material';
import { FONT_WEIGHT, STATUS, TYPO } from '../styles/tokens';

interface StepperHeaderProps {
  steps: readonly string[];
  activeStep: number;
  error?: boolean;
}

export default function StepperHeader({
  steps,
  activeStep,
  error = false,
}: StepperHeaderProps) {
  const theme = useTheme();
  const accent = theme.palette.primary.main;
  const idle = theme.palette.divider;
  const mutedLabel = theme.palette.text.secondary;

  return (
    <Stepper
      activeStep={activeStep}
      alternativeLabel
      sx={{
        width: '100%',
        '& .MuiStepConnector-line': {
          borderColor: idle,
        },
      }}
    >
      {steps.map((label, index) => {
        const isActive = index === activeStep;
        const isCompleted = index < activeStep;
        const isErrored = error && isActive;

        return (
          <Step key={label} completed={isCompleted}>
            <StepLabel
              error={isErrored}
              sx={{
                '& .MuiStepLabel-label': {
                  fontSize: TYPO.micro,
                  color: mutedLabel,
                  mt: 0.5,
                  '&.Mui-active': {
                    color: isErrored ? STATUS.error : accent,
                    fontWeight: FONT_WEIGHT.semibold,
                  },
                  '&.Mui-completed': {
                    color: STATUS.success,
                  },
                },
                '& .MuiStepIcon-root': {
                  fontSize: '1.25rem',
                  color: idle,
                  '&.Mui-active': {
                    color: isErrored ? STATUS.error : accent,
                  },
                  '&.Mui-completed': {
                    color: STATUS.success,
                  },
                },
              }}
            >
              {label}
            </StepLabel>
          </Step>
        );
      })}
    </Stepper>
  );
}
