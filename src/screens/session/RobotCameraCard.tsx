/**
 * Floating camera thumbnail rendered over the conversation panel.
 *
 *   ┌──────────────┐
 *   │ ● LIVE       │   (only visible while a video frame is playing)
 *   │              │
 *   │   <video>    │
 *   │              │
 *   └──────────────┘
 *
 * The card binds a `<video>` element to the robot's WebRTC video
 * track via `session.attachVideo()`. The SDK keeps the binding live
 * across release / reacquire cycles, so the card can stay mounted
 * for the whole session.
 *
 * UX choices
 * ──────────
 *   - Anchored top-left of the conversation surface (`position:
 *     absolute`), 16px from each edge. The host's container must be
 *     `position: relative`.
 *   - Ratio 4:3 to match the camera frame, ~140px wide on a 430px
 *     viewport - just enough to recognise faces / scene without
 *     stealing the orb's spotlight.
 *   - Soft shadow + 1px outline using the divider colour, so it
 *     reads as "secondary surface" rather than a primary CTA.
 *   - "LIVE" pip in the top-left corner of the card while a frame
 *     is actively playing; collapses to a "Camera offline"
 *     placeholder when the stream is unavailable (release, error,
 *     or robot without a camera).
 */
import { Box, Typography } from '@mui/material';
import VideocamOffIcon from '@mui/icons-material/VideocamOff';
import { useEffect, useRef, useState } from 'react';

import type { RobotSessionHandle } from '../../session/useRobotSession';
import { FONT_WEIGHT, RADIUS, TYPO } from '../../styles/tokens';

interface RobotCameraCardProps {
  /** Bound to the engine's `attachVideo()` only - we don't read any
   *  other field from the handle here. Passing the full `session`
   *  keeps the call-site short and lets us add status hooks later
   *  without changing the API. */
  session: Pick<RobotSessionHandle, 'attachVideo'>;
}

export default function RobotCameraCard({ session }: RobotCameraCardProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  /**
   * "Has the SDK pushed at least one frame since the last
   * `srcObject = null` event?" Used to drive the LIVE pip / fallback
   * empty-state. Toggled by the video element's own playback events
   * so we don't have to peek at the underlying MediaStream.
   */
  const [streaming, setStreaming] = useState(false);

  // Binding lifecycle. We attach exactly once: the SDK persists the
  // listener across `stopSession` / `startSession` cycles, so a
  // release / reacquire automatically refills the `srcObject` on the
  // same element without us re-attaching here.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const detach = session.attachVideo(el);
    return () => {
      detach();
    };
    // `session.attachVideo` is a stable callback from the hook, so
    // depending on the whole `session` object would re-run the
    // effect on every state change - which would un-attach the video
    // mid-session. We deliberately attach once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Video element playback state -> `streaming` flag. `playing` fires
  // when the track has decoded the first frame; `emptied` fires when
  // `srcObject` is set to null (release, teardown). `pause` is a
  // softer signal we treat as "still streaming" because the SDK can
  // pause the element implicitly during fast tab-switches.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const onPlaying = (): void => setStreaming(true);
    const onEmptied = (): void => setStreaming(false);
    const onSuspend = (): void => {
      if (!el.srcObject) setStreaming(false);
    };
    el.addEventListener('playing', onPlaying);
    el.addEventListener('emptied', onEmptied);
    el.addEventListener('suspend', onSuspend);
    return () => {
      el.removeEventListener('playing', onPlaying);
      el.removeEventListener('emptied', onEmptied);
      el.removeEventListener('suspend', onSuspend);
    };
  }, []);

  return (
    <Box
      sx={theme => ({
        position: 'absolute',
        top: 12,
        left: 12,
        width: 140,
        aspectRatio: '4 / 3',
        borderRadius: `${RADIUS.lg}px`,
        overflow: 'hidden',
        bgcolor:
          theme.palette.mode === 'dark'
            ? 'rgba(0, 0, 0, 0.55)'
            : 'rgba(0, 0, 0, 0.85)',
        border: `1px solid ${theme.palette.divider}`,
        boxShadow:
          theme.palette.mode === 'dark'
            ? '0 6px 18px rgba(0, 0, 0, 0.45)'
            : '0 6px 18px rgba(0, 0, 0, 0.15)',
        zIndex: 2,
      })}
    >
      <Box
        component="video"
        ref={videoRef}
        playsInline
        autoPlay
        muted
        sx={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          display: streaming ? 'block' : 'none',
          // Disable the user's mirror-reflex for a robot-mounted
          // camera: we want the operator to see the scene as the
          // robot sees it, not as if it were a selfie cam.
          transform: 'none',
        }}
      />
      {!streaming && <CameraOfflineFallback />}
      {streaming && <LivePip />}
    </Box>
  );
}

/**
 * Tiny "● LIVE" badge anchored to the top-left of the card. Sits
 * inside the card so it occludes the live frame slightly without
 * needing any separate layer.
 */
function LivePip() {
  return (
    <Box
      sx={{
        position: 'absolute',
        top: 6,
        left: 6,
        display: 'flex',
        alignItems: 'center',
        gap: 0.5,
        bgcolor: 'rgba(0, 0, 0, 0.45)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        px: 0.75,
        py: 0.25,
        borderRadius: 999,
        pointerEvents: 'none',
      }}
    >
      <Box
        sx={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          bgcolor: '#ef4444',
          // Slow pulse: 1.6s gives a visible breathe without
          // distracting from the orb's primary animation.
          animation: 'cameraLivePulse 1.6s ease-in-out infinite',
          '@keyframes cameraLivePulse': {
            '0%, 100%': { opacity: 0.55 },
            '50%': { opacity: 1 },
          },
        }}
      />
      <Typography
        component="span"
        sx={{
          fontSize: TYPO.micro,
          fontWeight: FONT_WEIGHT.bold,
          letterSpacing: '0.6px',
          color: '#fff',
          textTransform: 'uppercase',
          lineHeight: 1,
        }}
      >
        Live
      </Typography>
    </Box>
  );
}

/**
 * Empty-state shown until the first video frame arrives, or when the
 * stream is torn down (release, error). Kept intentionally minimal:
 * a muted icon + caption is enough signal that the camera is "off
 * right now" without competing with the conversation chrome.
 */
function CameraOfflineFallback() {
  return (
    <Box
      sx={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 0.5,
        color: 'rgba(255, 255, 255, 0.6)',
      }}
    >
      <VideocamOffIcon sx={{ fontSize: 22 }} />
      <Typography
        component="span"
        sx={{
          fontSize: TYPO.micro,
          fontWeight: FONT_WEIGHT.medium,
          letterSpacing: '0.3px',
          textAlign: 'center',
          px: 1,
        }}
      >
        Camera offline
      </Typography>
    </Box>
  );
}
