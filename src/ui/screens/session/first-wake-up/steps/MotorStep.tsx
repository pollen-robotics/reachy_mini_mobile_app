import { TROUBLE_TIPS } from '../constants';
import { useTroubleshoot } from '../hooks';
import { EmoteStepActions, StepScaffold, TroubleshootView } from '../shared';

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
        <EmoteStepActions
          playing={playing}
          played={played}
          onConfirm={onNext}
          onReplay={onReplay}
          onTrouble={openTrouble}
          labels={{
            playing: 'Moving…',
            start: 'Make Reachy move',
            confirm: 'Yes, it moved',
            replay: 'Move again',
            trouble: "It didn't move",
          }}
        />
      }
    />
  );
}
