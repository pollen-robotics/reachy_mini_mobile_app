/**
 * Floating camera thumbnail anchored to the top-left of the
 * conversation surface.
 *
 *   ┌──────────────┐
 *   │ ● LIVE       │
 *   │              │
 *   │   <video>    │     ← absolute positioned
 *   │              │
 *   └──────────────┘
 *
 * Thin wrapper around `VideoFeed`: positions it as a 4:3 card
 * pinned to the top-left corner of its closest positioned
 * ancestor. The host (`RobotSessionScreen`) is expected to
 * make its conv-tab column `position: relative` (which it
 * already is).
 *
 * Soft outline + drop shadow so the card reads as "secondary
 * surface" rather than competing with the orb's primary
 * spotlight.
 */
import { Box } from '@mui/material';

import VideoFeed from './components/VideoFeed';
import type { RobotSessionHandle } from '../../session/useRobotSession';
import { RADIUS } from '@/ui/design/tokens';

interface CameraOverlayProps {
  /** Only `attachVideo` is consumed - keeps the call-site
   *  minimal and the component reusable elsewhere. */
  session: Pick<RobotSessionHandle, 'attachVideo'>;
}

export default function CameraOverlay({ session }: CameraOverlayProps) {
  return (
    <Box
      sx={theme => ({
        position: 'absolute',
        top: 12,
        left: 12,
        width: 130,
        aspectRatio: '4 / 3',
        borderRadius: `${RADIUS.lg}px`,
        overflow: 'hidden',
        border: `1px solid ${theme.palette.divider}`,
        boxShadow:
          theme.palette.mode === 'dark'
            ? '0 6px 18px rgba(0, 0, 0, 0.45)'
            : '0 6px 18px rgba(0, 0, 0, 0.15)',
        zIndex: 2,
      })}
    >
      <VideoFeed session={session} />
    </Box>
  );
}
