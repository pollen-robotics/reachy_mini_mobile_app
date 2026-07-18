import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Typography, keyframes } from '@mui/material';

import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';
import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';
import { TROUBLE_TIPS } from '../constants';
import { useTroubleshoot } from '../hooks';
import { ButtonSpinner, PrimaryButton, StepScaffold, TroubleLink, TroubleshootView } from '../shared';
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
  onStageVisible,
  playing,
}: {
  session: RobotSessionHandle;
  onNext: () => void;
  onStageVisible: (visible: boolean) => void;
  /** True while the shell-fired `curious1` intro emote is playing (keeps the
   *  confirm button disabled + spinning). Fired by the wizard shell on entry;
   *  see `useStepEmotes`. */
  playing: boolean;
}) {
  const [hasFrame, setHasFrame] = useState(false);
  // This step owns its own camera stage (not the shared viz), so keep the viz
  // hidden even when the troubleshooting view closes.
  const { trouble, openTrouble, closeTrouble } = useTroubleshoot(onStageVisible, {
    restoreStageOnClose: false,
  });
  const detachRef = useRef<(() => void) | null>(null);

  // This is the only step whose stage isn't the shell's persistent (top-pinned)
  // 3D viz - the camera module owns the stage and we center the content
  // vertically. Hide the persistent viz so it doesn't peek out at the top once
  // the camera stage is no longer covering it. Restored by the shell on step
  // change (and on leaving the troubleshooting view).
  useEffect(() => {
    onStageVisible(false);
  }, [onStageVisible]);

  // Attach via a *callback ref* rather than an effect, so the feed re-binds
  // every time the <video> (re)mounts. Toggling the troubleshooting view
  // swaps the whole subtree (this component stays mounted, so an
  // `[attachVideo]` effect never re-runs), which would otherwise leave the
  // remounted <video> without an `srcObject` -> black canvas on return.
  //
  // `attachVideo` is a stable `useCallback([])` from `useRobotSession`, so
  // this ref identity is stable too (no attach/detach churn on the frequent
  // re-renders of the screen underneath this overlay).
  const { attachVideo } = session;
  const setVideoEl = useCallback(
    (el: HTMLVideoElement | null) => {
      detachRef.current?.();
      detachRef.current = null;
      if (!el) return;
      setHasFrame(false);
      const detach = attachVideo(el);
      const onPlaying = () => setHasFrame(true);
      // Cover several events: on a late mount (this step comes AFTER the motor
      // step, so the WebRTC stream is usually already live) the first
      // frame can land before/around the attach, and different webviews fire
      // different events.
      const events = ['loadeddata', 'loadedmetadata', 'canplay', 'playing'] as const;
      events.forEach(ev => el.addEventListener(ev, onPlaying));
      // Safety net: if the element already holds a decoded frame (events may
      // have fired before we attached) or a hidden video never emits `playing`
      // on this webview, flip as soon as it has data. Cleared on detach.
      const poll = window.setInterval(() => {
        if (el.readyState >= 2 || el.videoWidth > 0) setHasFrame(true);
      }, 200);
      detachRef.current = () => {
        window.clearInterval(poll);
        events.forEach(ev => el.removeEventListener(ev, onPlaying));
        detach();
      };
    },
    [attachVideo],
  );

  if (trouble) {
    return (
      <TroubleshootView
        title={TROUBLE_TIPS.camera.title}
        tips={TROUBLE_TIPS.camera.tips}
        onBack={closeTrouble}
      />
    );
  }

  return (
    <StepScaffold
      centered
      stageHeight={270}
      title="See Through My Eyes"
      caption="I'll open my eyes. Check that you can see my camera feed."
      stageOverlay={
        // The only step where the stage isn't the 3D viz: the camera module
        // fills the slot and covers the persistent viz sitting behind it.
        <Box
          sx={{
            // Don't stretch edge-to-edge like the 3D stage: a centered,
            // fixed-width module. Height follows a 4:3 camera aspect (instead of
            // filling the whole stage height) so the feed keeps its ratio.
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: '80%',
            maxWidth: 360,
            aspectRatio: '4 / 3',
            borderRadius: `${RADIUS.lg}px`,
            overflow: 'hidden',
            bgcolor: '#1a1a1a',
            border: theme => `1px solid ${theme.palette.divider}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'auto',
          }}
        >
          {/* Keep the <video> mounted and merely transparent (not display:none) so
              the webview actually decodes it and emits playback events - a hidden
              video can stay black forever on WKWebView. Overlays sit on top until
              the first frame lands. */}
          <Box
            component="video"
            ref={setVideoEl}
            autoPlay
            muted
            playsInline
            sx={{
              position: 'absolute',
              inset: 0,
              zIndex: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              opacity: hasFrame ? 1 : 0,
              clipPath: 'ellipse(100% 0% at 50% 50%)',
              animation: hasFrame
                ? `${eyeOpen} 1s ease-out forwards, ${eyeBlink} 0.25s ease-in-out 1.2s, ${eyeBlink} 0.3s ease-in-out 2.1s`
                : 'none',
            }}
          />
          {!hasFrame ? <StaticNoise /> : null}
          {!hasFrame ? (
            <Typography
              sx={{ position: 'relative', zIndex: 1, color: 'rgba(255,255,255,0.7)', fontSize: TYPO.sm, fontWeight: FONT_WEIGHT.medium }}
            >
              Opening my eye…
            </Typography>
          ) : null}
        </Box>
      }
      actions={
        <>
          {/* Spinner for the whole duration of the `curious1` intro emote: the
              confirm stays disabled + spinning until the move finishes, so the
              user waits out the eye-opening animation before confirming. The
              trouble link / header Skip remain available throughout. */}
          <PrimaryButton
            onClick={onNext}
            disabled={playing}
            startIcon={playing ? <ButtonSpinner /> : undefined}
          >
            I can see it
          </PrimaryButton>
          <TroubleLink label="Camera doesn't work" onClick={openTrouble} />
        </>
      }
    />
  );
}
