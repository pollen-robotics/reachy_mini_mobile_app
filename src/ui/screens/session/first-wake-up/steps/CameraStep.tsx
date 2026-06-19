import { useEffect, useRef, useState } from 'react';
import { Box, Stack, Typography, keyframes } from '@mui/material';

import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';
import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';
import { TROUBLE_TIPS } from '../constants';
import { Headline, PrimaryButton, TroubleLink, TroubleshootView } from '../shared';
import StaticNoise from '../StaticNoise';

/** Camera reveal: the feed "opens" like an eye (clip-path ellipse from a
 *  slit to fully open), then blinks a couple of times. */
const eyeOpen = keyframes`
  0%   { clip-path: ellipse(100% 0% at 50% 50%); }
  100% { clip-path: ellipse(100% 50% at 50% 50%); }
`;
const eyeBlink = keyframes`
  0%, 100% { clip-path: ellipse(100% 50% at 50% 50%); }
  50%      { clip-path: ellipse(100% 5% at 50% 50%); }
`;

export default function CameraStep({
  session,
  onNext,
}: {
  session: RobotSessionHandle;
  onNext: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [trouble, setTrouble] = useState(false);

  // Depend on the stable `attachVideo` callback (a `useCallback([])` in
  // `useRobotSession`), NOT the whole `session` object. The handle is a
  // fresh object literal on every render, and the screen underneath this
  // overlay re-renders often (orb / audio state); depending on `session`
  // would tear down + re-attach the feed each time, blanking
  // `srcObject` to null for a frame and flickering the video to black.
  const { attachVideo } = session;
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const detach = attachVideo(el);
    const onPlaying = () => setHasFrame(true);
    el.addEventListener('loadeddata', onPlaying);
    el.addEventListener('playing', onPlaying);
    return () => {
      el.removeEventListener('loadeddata', onPlaying);
      el.removeEventListener('playing', onPlaying);
      detach();
    };
  }, [attachVideo]);

  if (trouble) {
    return (
      <TroubleshootView
        title={TROUBLE_TIPS.camera.title}
        tips={TROUBLE_TIPS.camera.tips}
        onBack={() => setTrouble(false)}
      />
    );
  }

  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <Headline title="Let me see!" caption="Wave hello - watch my eye open as the camera comes to life." />
      <Box
        sx={{
          position: 'relative',
          width: '100%',
          maxWidth: 320,
          aspectRatio: '4 / 3',
          borderRadius: `${RADIUS.lg}px`,
          overflow: 'hidden',
          bgcolor: '#1a1a1a',
          border: theme => `1px solid ${theme.palette.divider}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {!hasFrame ? <StaticNoise /> : null}
        {!hasFrame ? (
          <Typography
            sx={{ position: 'relative', zIndex: 1, color: 'rgba(255,255,255,0.7)', fontSize: TYPO.sm, fontWeight: FONT_WEIGHT.medium }}
          >
            Opening my eye…
          </Typography>
        ) : null}
        <Box
          component="video"
          ref={videoRef}
          autoPlay
          muted
          playsInline
          sx={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: hasFrame ? 'block' : 'none',
            clipPath: 'ellipse(100% 0% at 50% 50%)',
            animation: hasFrame
              ? `${eyeOpen} 1s ease-out forwards, ${eyeBlink} 0.25s ease-in-out 1.2s, ${eyeBlink} 0.3s ease-in-out 2.1s`
              : 'none',
          }}
        />
      </Box>
      <Box sx={{ width: '100%', maxWidth: 320 }}>
        <PrimaryButton onClick={onNext} disabled={!hasFrame}>
          {hasFrame ? 'I can see it' : 'Waiting for the camera…'}
        </PrimaryButton>
      </Box>
      <TroubleLink label="Camera doesn't work" onClick={() => setTrouble(true)} />
    </Stack>
  );
}
