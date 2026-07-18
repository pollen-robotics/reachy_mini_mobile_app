import { useCallback } from 'react';
import { Slider, Stack, Typography } from '@mui/material';
import VolumeUpRoundedIcon from '@mui/icons-material/VolumeUpRounded';

import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';
import { TYPO } from '@/ui/design/tokens';
import { TROUBLE_TIPS } from '../constants';
import { useTroubleshoot } from '../hooks';
import { EmoteStepActions, StepScaffold, TroubleshootView } from '../shared';

/**
 * "Hear My Voice" step. The proud2 emote (motion + sound) is fired by the wizard
 * shell as a navigation event (on entry, and on "Play again" via `onReplay`);
 * this step owns only the volume slider and reflects the play state. See
 * `useStepEmotes` for why the trigger lives in the shell, not a mount effect.
 *
 * The volume is CONTROLLED by the shell, which prefetches it on wizard mount so
 * the slider is already at the real value here rather than showing a default and
 * jumping once an on-mount read lands. See `speakerVolume` in the shell.
 */
export default function SpeakerStep({
  session,
  onNext,
  onStageVisible,
  playing,
  played,
  onReplay,
  volume,
  onVolumeChange,
}: {
  session: RobotSessionHandle;
  onNext: () => void;
  onStageVisible: (visible: boolean) => void;
  /** True while the shell-fired sound emote is playing (button shows "Playing…"). */
  playing: boolean;
  /** True once the emote finished (reveal the confirm controls). */
  played: boolean;
  /** Replay the sound emote ("Play test sound" / "Play again"). */
  onReplay: () => void;
  /** Current volume (0-100), prefetched by the shell so the slider starts at the
   *  right value. `null` only during the initial read (rare by the time this
   *  step is reached), which disables the slider until it resolves. */
  volume: number | null;
  /** Update the shell's volume (drag). The daemon write happens on release. */
  onVolumeChange: (v: number) => void;
}) {
  const { trouble, openTrouble, closeTrouble } = useTroubleshoot(onStageVisible);

  const commitVolume = useCallback(
    (v: number) => {
      void session.setSpeakerVolume(v);
    },
    [session],
  );

  if (trouble) {
    return (
      <TroubleshootView
        title={TROUBLE_TIPS.speaker.title}
        tips={TROUBLE_TIPS.speaker.tips}
        onBack={closeTrouble}
      />
    );
  }

  return (
    <StepScaffold
      // No overlay: the shared persistent viz stays on screen and animates the
      // proud2 emotion when the test sound plays.
      title="Hear My Voice"
      caption="I'll play a sound. Adjust my volume until it feels just right."
      feedback={
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', width: '100%', maxWidth: 320 }}>
          <VolumeUpRoundedIcon sx={{ color: 'text.secondary' }} />
          <Slider
            value={volume ?? 50}
            onChange={(_, v) => onVolumeChange(v as number)}
            onChangeCommitted={(_, v) => commitVolume(v as number)}
            min={0}
            max={100}
            disabled={volume === null}
            aria-label="Speaker volume"
            sx={{ flex: 1 }}
          />
          <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary', width: 36, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
            {Math.round(volume ?? 50)}
          </Typography>
        </Stack>
      }
      actions={
        <EmoteStepActions
          playing={playing}
          played={played}
          onConfirm={onNext}
          onReplay={onReplay}
          onTrouble={openTrouble}
          labels={{
            playing: 'Playing…',
            start: 'Play test sound',
            confirm: 'Yes, I hear it',
            replay: 'Play again',
            trouble: "I don't hear it",
          }}
        />
      }
    />
  );
}
