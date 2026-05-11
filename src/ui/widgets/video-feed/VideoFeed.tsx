/**
 * Robot camera live feed.
 *
 * Position-agnostic version of the previous floating
 * `RobotCameraCard`: this component just owns the video element
 * lifecycle (binding to the SDK track via `attachVideo`) and the
 * "is-streaming" state for the LIVE pip / offline fallback. The
 * caller decides where to put it (inline inside a flex layout, or
 * absolutely positioned over another surface).
 *
 * Modular by design - takes only the minimal slice of the session
 * handle it needs (`attachVideo`) so it can be lifted out of the
 * conversation view without dragging the whole engine surface
 * along.
 */
import { Box, Typography } from '@mui/material';
import VideocamOffIcon from '@mui/icons-material/VideocamOff';
import { useEffect, useRef, useState } from 'react';

import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';
import { FONT_WEIGHT, TYPO } from '@/ui/design/tokens';

interface VideoFeedProps {
  /** Only `attachVideo` is consumed - keeps the call-site minimal
   *  and the component reusable outside the conversation view. */
  session: Pick<RobotSessionHandle, 'attachVideo'>;
}

export default function VideoFeed({ session }: VideoFeedProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  /**
   * Tracks "has the SDK pushed at least one frame since the last
   * `srcObject = null` event?". Drives the LIVE pip vs offline
   * fallback. Toggled by the video element's own playback events,
   * so we never have to peek at the underlying MediaStream.
   */
  const [streaming, setStreaming] = useState(false);

  // Bind once. The SDK persists the listener across release /
  // reacquire cycles, so the same element gets a fresh srcObject
  // automatically without us having to re-attach.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const detach = session.attachVideo(el);
    return () => {
      detach();
    };
    // `session.attachVideo` is a stable callback from the hook;
    // depending on the whole `session` object would re-fire the
    // effect on every state change and disrupt the binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirror the video element's playback state into our `streaming`
  // flag. `playing` fires on the first decoded frame, `emptied`
  // fires when `srcObject` is set to null (release / teardown),
  // `suspend` is treated as "still streaming" because the SDK can
  // pause the element implicitly on fast tab switches.
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
        position: 'relative',
        width: '100%',
        height: '100%',
        // Top corners square: the video sits flush under the
        // RobotPanel's header strip (separated by a 1 px divider),
        // so a top radius would carve a paper-coloured notch into
        // the corners. The bottom radius matches the parent
        // `<RobotPanel>` so the video's own bg follows the card's
        // bottom curve cleanly. The parent's `overflow: hidden`
        // clips anything we'd over-shoot, but rendering a matching
        // radius here avoids the dark video painting outside its
        // own visible bounds during transforms.
        borderTopLeftRadius: 0,
        borderTopRightRadius: 0,
        borderBottomLeftRadius: '12px',
        borderBottomRightRadius: '12px',
        overflow: 'hidden',
        bgcolor:
          theme.palette.mode === 'dark'
            ? 'rgba(0, 0, 0, 0.55)'
            : 'rgba(0, 0, 0, 0.85)',
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
          // No mirror: the operator should see the scene as the
          // robot sees it, not a selfie reflection.
          transform: 'none',
        }}
      />
      {!streaming && <CameraOfflineFallback />}
      <CameraBadge />
    </Box>
  );
}

/**
 * Small "Camera · View from Reachy" pip anchored top-left over
 * the video. Replaces the earlier `● LIVE` badge: the parent
 * panel has no header strip (see `<RobotPanel>` usage in
 * `RobotTabView`), so this overlay carries the section's label
 * in-frame instead. Always rendered, regardless of streaming
 * state, so the user knows what they're looking at even during
 * the camera's offline / pre-stream interval.
 */
function CameraBadge() {
  return (
    <Box
      sx={{
        position: 'absolute',
        top: 10,
        left: 10,
        display: 'flex',
        alignItems: 'baseline',
        gap: 0.875,
        bgcolor: 'rgba(0, 0, 0, 0.45)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        px: 1,
        py: 0.375,
        borderRadius: 999,
        pointerEvents: 'none',
      }}
    >
      <Typography
        component="span"
        sx={{
          fontSize: TYPO.xs,
          fontWeight: FONT_WEIGHT.bold,
          letterSpacing: '0.6px',
          color: '#fff',
          textTransform: 'uppercase',
          lineHeight: 1,
        }}
      >
        Camera
      </Typography>
      <Typography
        component="span"
        sx={{
          fontSize: TYPO.tiny,
          fontWeight: FONT_WEIGHT.medium,
          color: 'rgba(255, 255, 255, 0.7)',
          lineHeight: 1,
        }}
      >
        View from Reachy
      </Typography>
    </Box>
  );
}

/** Empty state until the first frame arrives, or after teardown. */
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
