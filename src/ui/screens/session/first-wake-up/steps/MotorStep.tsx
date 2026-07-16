import { CircularProgress, Stack } from '@mui/material';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';

import { TROUBLE_TIPS } from '../constants';
import { useTroubleshoot } from '../hooks';
import { LinkDivider, PrimaryButton, StepScaffold, SubtleLink, TroubleLink, TroubleshootView } from '../shared';

/**
 * "Meet Me" step. Presentational: the wizard shell fires the wake emote as a
 * navigation event (on entry, and on "Move again" via `onReplay`) - this step
 * only reflects that state. See `useStepEmotes` for why the trigger lives in
 * the shell rather than a mount effect here.
 */
export default function MotorStep({
  onNext,
  onStageVisible,
  playing,
  played,
  onReplay,
}: {
  onNext: () => void;
  onStageVisible: (visible: boolean) => void;
  /** True while the shell-fired wake emote is playing (button shows "Moving…"). */
  playing: boolean;
  /** True once the wake emote finished (reveal the confirm controls). */
  played: boolean;
  /** Replay the wake emote ("Make Reachy move" / "Move again"). */
  onReplay: () => void;
}) {
  const { trouble, openTrouble, closeTrouble } = useTroubleshoot(onStageVisible);

  if (trouble) {
    return (
      <TroubleshootView
        title={TROUBLE_TIPS.motor.title}
        tips={TROUBLE_TIPS.motor.tips}
        onBack={closeTrouble}
      />
    );
  }

  return (
    <StepScaffold
      // No overlay: the shared persistent viz behind the stage mirrors the live
      // wake-up animation the user should see.
      title="Meet Me"
      caption="I'll perform my first animation. Make sure my movements match what you see on screen so every motor is working properly."
      actions={
        // Order matters: test `playing` FIRST so a replay ("Move again" from the
        // confirmed state) puts the spinner back on the primary button.
        playing ? (
          <PrimaryButton disabled startIcon={<CircularProgress size={16} sx={{ color: 'primary.main' }} />}>
            Moving…
          </PrimaryButton>
        ) : !played ? (
          <PrimaryButton onClick={onReplay}>Make Reachy move</PrimaryButton>
        ) : (
          <>
            <PrimaryButton startIcon={<CheckRoundedIcon />} onClick={onNext}>
              Yes, it moved
            </PrimaryButton>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <SubtleLink label="Move again" onClick={onReplay} />
              <LinkDivider />
              <TroubleLink label="It didn't move" onClick={openTrouble} />
            </Stack>
          </>
        )
      }
    />
  );
}
