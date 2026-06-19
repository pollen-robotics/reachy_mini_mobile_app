import { useCallback, useEffect, useState } from 'react';
import { Box, Slider, Stack, Typography } from '@mui/material';
import VolumeUpRoundedIcon from '@mui/icons-material/VolumeUpRounded';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';

import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';
import { TYPO } from '@/ui/design/tokens';
import { TEST_SOUND_FILE, TROUBLE_TIPS } from '../constants';
import { Headline, LinkDivider, PrimaryButton, SubtleLink, TroubleLink, TroubleshootView } from '../shared';

export default function SpeakerStep({
  session,
  onNext,
}: {
  session: RobotSessionHandle;
  onNext: () => void;
}) {
  const [trouble, setTrouble] = useState(false);
  const [volume, setVolume] = useState<number>(60);
  const [ready, setReady] = useState(false);
  const [hasPlayed, setHasPlayed] = useState(false);

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

  const playTest = useCallback(() => {
    session.playSound(TEST_SOUND_FILE);
    setHasPlayed(true);
  }, [session]);

  if (trouble) {
    return (
      <TroubleshootView
        title={TROUBLE_TIPS.speaker.title}
        tips={TROUBLE_TIPS.speaker.tips}
        onBack={() => setTrouble(false)}
      />
    );
  }

  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <Headline title="Can it speak?" caption="Play a test sound and set a comfortable volume for your room." />

      <Stack spacing={1} sx={{ width: '100%', maxWidth: 320 }}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', width: '100%' }}>
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
      </Stack>

      <Stack spacing={1.5} sx={{ width: '100%', maxWidth: 320, alignItems: 'center' }}>
        {!hasPlayed ? (
          <PrimaryButton onClick={playTest}>Play test sound</PrimaryButton>
        ) : (
          <>
            <PrimaryButton startIcon={<CheckRoundedIcon />} onClick={onNext}>
              Yes, I hear it
            </PrimaryButton>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <SubtleLink label="Play again" onClick={playTest} />
              <LinkDivider />
              <TroubleLink label="I don't hear it" onClick={() => setTrouble(true)} />
            </Stack>
          </>
        )}
      </Stack>
    </Stack>
  );
}
