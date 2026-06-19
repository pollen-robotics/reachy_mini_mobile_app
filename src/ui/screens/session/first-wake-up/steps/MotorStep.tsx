import { useCallback, useState } from 'react';
import { CircularProgress, Stack } from '@mui/material';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';

import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';
import { TROUBLE_TIPS } from '../constants';
import { Headline, LinkDivider, PrimaryButton, SubtleLink, TroubleLink, TroubleshootView } from '../shared';

export default function MotorStep({
  session,
  onNext,
  onWoke,
}: {
  session: RobotSessionHandle;
  onNext: () => void;
  /** Signals the wizard that the robot has been woken here, so it won't
   *  replay the wake move on finish. */
  onWoke: () => void;
}) {
  const [trouble, setTrouble] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [played, setPlayed] = useState(false);

  const play = useCallback(async () => {
    const robot = session.getRobot();
    if (!robot) return;
    setPlaying(true);
    try {
      await robot.wakeUp({ timeoutMs: 6000 });
      onWoke();
      setPlayed(true);
    } catch {
      // wakeUp can reject on a slow ack; still let the user move on.
      // Treat it as woken anyway: the command was sent, and we don't
      // want the wizard to replay the move on finish.
      onWoke();
      setPlayed(true);
    } finally {
      setPlaying(false);
    }
  }, [session, onWoke]);

  if (trouble) {
    return (
      <TroubleshootView
        title={TROUBLE_TIPS.motor.title}
        tips={TROUBLE_TIPS.motor.tips}
        onBack={() => setTrouble(false)}
      />
    );
  }

  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <Headline
        title="Can it move?"
        caption="Tap below and watch Reachy stretch - its head should tilt and the antennas should wiggle."
      />
      <Stack spacing={1.5} sx={{ width: '100%', maxWidth: 320, alignItems: 'center' }}>
        {!played ? (
          <PrimaryButton onClick={() => void play()} disabled={playing}>
            {playing ? (
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <CircularProgress size={16} sx={{ color: 'primary.main' }} />
                <span>Moving…</span>
              </Stack>
            ) : (
              'Make Reachy move'
            )}
          </PrimaryButton>
        ) : (
          <>
            <PrimaryButton startIcon={<CheckRoundedIcon />} onClick={onNext}>
              Yes, it moved
            </PrimaryButton>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <SubtleLink
                label={playing ? 'Moving…' : 'Move again'}
                onClick={() => void play()}
                disabled={playing}
              />
              <LinkDivider />
              <TroubleLink label="It didn't move" onClick={() => setTrouble(true)} />
            </Stack>
          </>
        )}
      </Stack>
    </Stack>
  );
}
