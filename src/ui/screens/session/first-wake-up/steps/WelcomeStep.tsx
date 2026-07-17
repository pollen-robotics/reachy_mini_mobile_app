import { useEffect, useRef } from 'react';
import { Stack, Typography, alpha } from '@mui/material';
import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';

import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';
import type { SleepPositionCheck } from '@/ui/widgets/reachy-viz/useSleepPositionCheck';
import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';
import { PrimaryButton, StepScaffold } from '../shared';

/** Compact motor names for the inline dot-separated list. */
function shortMotor(name: string): string {
  return name
    .replace(/^Neck motor /, 'Neck ')
    .replace(/^Right antenna$/, 'R. antenna')
    .replace(/^Left antenna$/, 'L. antenna')
    .replace(/^Base rotation$/, 'Base');
}

export default function WelcomeStep({
  session,
  onNext,
  check,
  blocked,
}: {
  session: RobotSessionHandle;
  onNext: () => void;
  /** Live sleep-pose comparison, owned by the shell (also drives the ghost). */
  check: SleepPositionCheck;
  /** True while the robot isn't yet in its sleep position. */
  blocked: boolean;
}) {
  // Release motor torque on entry so the user can physically place the robot in
  // its sleep position by hand. Without this the robot may still be holding
  // (torque on) after the setup's go-to-sleep cue (SLEEP) or a previously-awake
  // session, and it wouldn't budge. Limp mode also makes the live joint stream
  // reflect exactly where the user puts it, which is what the position check
  // reads. Fire-and-forget; guarded so it runs once.
  const releasedRef = useRef(false);
  useEffect(() => {
    if (releasedRef.current) return;
    releasedRef.current = true;
    session.getRobot()?.setMotorMode('disabled');
  }, [session]);

  // The live robot is the shared persistent viz; the shell overlays a
  // translucent "target" ghost of the sleep pose in the same canvas (orange,
  // turning green when aligned), so there's no per-step overlay to render here.
  return (
    <StepScaffold
      title="Tuck Me In"
      caption="Place me in my sleep position - match me to the orange target."
      feedback={
        blocked ? (
          <Stack
            spacing={0.75}
            sx={{
              width: '100%',
              maxWidth: 340,
              px: 2,
              py: 1.5,
              borderRadius: `${RADIUS.lg}px`,
              bgcolor: theme => alpha(theme.palette.warning.main, 0.1),
              border: theme => `1px solid ${alpha(theme.palette.warning.main, 0.4)}`,
            }}
          >
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <WarningAmberRoundedIcon sx={{ fontSize: 18, color: 'warning.main' }} />
              <Typography sx={{ fontSize: TYPO.sm, fontWeight: FONT_WEIGHT.semibold, color: 'warning.main' }}>
                {check.offMotors.length === 1
                  ? '1 motor to adjust'
                  : `${check.offMotors.length} motors to adjust`}
              </Typography>
            </Stack>
            <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary', lineHeight: 1.6 }}>
              {check.offMotors.map(shortMotor).join('  ·  ')}
            </Typography>
          </Stack>
        ) : check.inPosition ? (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <CheckCircleOutlineRoundedIcon sx={{ fontSize: 18, color: 'success.main' }} />
            <Typography sx={{ fontSize: TYPO.sm, fontWeight: FONT_WEIGHT.medium, color: 'success.main' }}>
              I'm tucked in and ready
            </Typography>
          </Stack>
        ) : null
      }
      actions={
        <PrimaryButton onClick={onNext} disabled={blocked}>
          {blocked ? 'Place me in sleep position' : "Let's go"}
        </PrimaryButton>
      }
    />
  );
}
