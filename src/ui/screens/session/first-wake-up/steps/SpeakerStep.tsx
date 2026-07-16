import { useCallback, useEffect, useState } from 'react';
import { CircularProgress, Slider, Stack, Typography } from '@mui/material';
import VolumeUpRoundedIcon from '@mui/icons-material/VolumeUpRounded';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';

import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';
import { TYPO } from '@/ui/design/tokens';
import { TROUBLE_TIPS } from '../constants';
import { useTroubleshoot } from '../hooks';
import { LinkDivider, PrimaryButton, StepScaffold, SubtleLink, TroubleLink, TroubleshootView } from '../shared';

/**
 * "Hear My Voice" step. The proud2 emote (motion + sound) is fired by the wizard
 * shell as a navigation event (on entry, and on "Play again" via `onReplay`);
 * this step owns only the volume slider and reflects the play state. See
 * `useStepEmotes` for why the trigger lives in the shell, not a mount effect.
 */
export default function SpeakerStep({
  session,
  onNext,
  onStageVisible,
  playing,
  played,
  onReplay,
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
}) {
  const { trouble, openTrouble, closeTrouble } = useTroubleshoot(onStageVisible);
  const [volume, setVolume] = useState<number>(60);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void session.getSpeakerVolume().then(v => {
      if (cancelled) return;
      if (typeof v === 'number') setVolume(v);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [session]);

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
            value={volume}
            onChange={(_, v) => setVolume(v as number)}
            onChangeCommitted={(_, v) => commitVolume(v as number)}
            min={0}
            max={100}
            disabled={!ready}
            aria-label="Speaker volume"
            sx={{ flex: 1 }}
          />
          <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary', width: 36, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
            {Math.round(volume)}
          </Typography>
        </Stack>
      }
      actions={
        playing ? (
          <PrimaryButton disabled startIcon={<CircularProgress size={16} sx={{ color: 'primary.main' }} />}>
            Playing…
          </PrimaryButton>
        ) : !played ? (
          <PrimaryButton onClick={onReplay}>Play test sound</PrimaryButton>
        ) : (
          <>
            <PrimaryButton startIcon={<CheckRoundedIcon />} onClick={onNext}>
              Yes, I hear it
            </PrimaryButton>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <SubtleLink label="Play again" onClick={onReplay} />
              <LinkDivider />
              <TroubleLink label="I don't hear it" onClick={openTrouble} />
            </Stack>
          </>
        )
      }
    />
  );
}
