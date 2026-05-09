/**
 * Robot tab body.
 *
 *   ┌──────────────────────────────────┐
 *   │                                  │
 *   │  CAMERA                          │
 *   │  ┌────────────────────────────┐  │  ← 4:3 video feed, full width
 *   │  │  ● LIVE                    │  │
 *   │  │     <video>                │  │
 *   │  │                       ╭──╮ │  │  ← head joystick overlay,
 *   │  │                       │··│ │  │     bottom-right (cf.
 *   │  │                       ╰──╯ │  │     `head-control/`)
 *   │  └────────────────────────────┘  │
 *   │                                  │
 *   │  Speaker      Microphone         │  ← cards' own labels are
 *   │  ┌──────────┐ ┌─────────────┐    │     enough; no umbrella
 *   │  │ [🔊]●─●  │ │ [🎤]●─●     │    │     "Audio" section header
 *   │  └──────────┘ └─────────────┘    │
 *   │                                  │
 *   └──────────────────────────────────┘
 *
 * Pure consumer of the session handle: takes only the slice of
 * `RobotSessionHandle` it needs (`Pick`) so the same view can be
 * lifted out of the screen and unit-tested with a fake. Mirrors the
 * desktop's "left column" feature set (camera + audio devices) plus
 * a mobile-native joystick for manual head steering, minus the bits
 * that don't translate to mobile (3D viewer, gamepad sliders, daemon
 * log console).
 *
 * No sub-header by design: the screen-level top bar already carries
 * the robot identity (name, hardware id, transport, version) via
 * `<IdentityChipBar>`, and the bottom-nav already labels the active
 * tab. Repeating "Robot · Camera and audio controls" inside the tab
 * body would be pure chrome with no informational gain - the user
 * landed here intentionally and the section labels below are enough
 * to anchor what each block is.
 *
 * Layout convention is shared with the Apps tab:
 *   - parent `Stack` escapes the host column constraints via the
 *     `100vw` + `calc(50% - 50vw)` trick so the scrollable body
 *     spans flush to the viewport edges,
 *   - inside, every row re-applies `COLUMN_SX` so titles and content
 *     stay on a single centred column.
 */
import { Box, Stack, Typography } from '@mui/material';

import VideoFeed from '@/ui/widgets/video-feed/VideoFeed';
import AudioControlCard from '@/ui/widgets/audio-controls/AudioControlCard';
import { useAudioVolumes } from '@/ui/widgets/audio-controls/useAudioVolumes';
import { HeadJoystickOverlay } from '@/ui/widgets/head-control';
import type { RobotSessionHandle } from '@/features/session/useRobotSession';
import { FONT_WEIGHT, LAYOUT, RADIUS, TYPO } from '@/ui/design/tokens';

interface RobotTabViewProps {
  /**
   * Slice of the session the tab needs. Typed via `Pick` so the
   * dependency surface is explicit at the call site and the view
   * can be unit-tested with a fake handle. `playSound` is still
   * required because `useAudioVolumes` plays an audible chime as
   * feedback when the user settles on a new volume.
   */
  session: Pick<
    RobotSessionHandle,
    | 'attachVideo'
    | 'getSpeakerVolume'
    | 'setSpeakerVolume'
    | 'getMicrophoneVolume'
    | 'setMicrophoneVolume'
    | 'playSound'
    | 'setHeadRpyDeg'
  >;
  /**
   * Becomes `true` once the engine has reached `ready` for the
   * first time (mirrors `AudioControlsBar.isLive`). Drives the
   * volume hook's initial fetch and the disabled state of the
   * audio cards. The camera feed itself decides its own offline
   * state from the SDK's track, so it doesn't need this gate.
   */
  isLive: boolean;
}

/**
 * Shared `sx` that re-constrains a row to the centred content
 * column. Same pattern as the Apps tab so the two surfaces feel
 * built by the same hand.
 */
const COLUMN_SX = {
  width: '100%',
  maxWidth: LAYOUT.contentMaxWidth,
  mx: 'auto',
  px: 3,
} as const;

export default function RobotTabView({ session, isLive }: RobotTabViewProps) {
  const volumes = useAudioVolumes({ session, enabled: isLive });

  return (
    <Stack
      sx={{
        flex: 1,
        minHeight: 0,
        // Full-bleed escape hatch (see AppsTabView for the
        // long-form rationale): the host column is `maxWidth: 420`
        // inside a `Stack px: 3`, this pair pulls us back out to
        // the viewport edges so the scroll container can host
        // future full-bleed UI (e.g. a fullscreen camera lightbox).
        width: '100vw',
        mx: 'calc(50% - 50vw)',
        overflow: 'hidden',
      }}
    >
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          // Bottom padding so the last control isn't hugged by the
          // BottomNavigation. Top padding gives the first section
          // some breathing room below the screen-level top bar.
          pt: 1,
          pb: 2,
        }}
      >
        <Stack spacing={3} sx={COLUMN_SX}>
          <Section label="Camera">
            <Box
              sx={(theme) => ({
                position: 'relative',
                width: '100%',
                aspectRatio: '4 / 3',
                borderRadius: `${RADIUS.lg}px`,
                overflow: 'hidden',
                border: `1px solid ${theme.palette.divider}`,
                boxShadow:
                  theme.palette.mode === 'dark'
                    ? '0 6px 18px rgba(0, 0, 0, 0.45)'
                    : '0 6px 18px rgba(0, 0, 0, 0.10)',
              })}
            >
              <VideoFeed session={session} />
              {/* Head joystick anchored bottom-right of the camera
                  frame. Mounting starts the velocity controller;
                  unmounting (e.g. user navigates away from this
                  tab) triggers a smooth recenter back to (0, 0).
                  We gate `enabled` on `isLive` so the joystick is
                  faded down + non-interactive until the engine
                  has reached `ready` for the first time. */}
              <HeadJoystickOverlay session={session} enabled={isLive} />
            </Box>
          </Section>

          {/* Audio cards rendered without the section label: the
              two cards already carry their own "Speaker" /
              "Microphone" headers (the AudioControlCard renders
              them outside the card chrome), so an extra "AUDIO"
              umbrella above would be redundant labelling. */}
          <Stack direction="row" spacing={1.25} sx={{ width: '100%' }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <AudioControlCard
                kind="speaker"
                value={volumes.speakerVolume}
                onChange={volumes.setSpeakerVolume}
                onToggleMute={volumes.toggleSpeakerMute}
                disabled={!isLive}
              />
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <AudioControlCard
                kind="microphone"
                value={volumes.microphoneVolume}
                onChange={volumes.setMicrophoneVolume}
                onToggleMute={volumes.toggleMicrophoneMute}
                disabled={!isLive}
              />
            </Box>
          </Stack>
        </Stack>
      </Box>
    </Stack>
  );
}

/**
 * Section block: tiny uppercase label above its child(ren). Mirrors
 * the AudioControlCard's outside-label convention so the camera and
 * audio sections feel typographically aligned.
 */
function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Stack spacing={1}>
      <Typography
        sx={{
          fontSize: TYPO.tiny,
          fontWeight: FONT_WEIGHT.semibold,
          color: 'text.secondary',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          lineHeight: 1.1,
          ml: 0.25,
        }}
      >
        {label}
      </Typography>
      {children}
    </Stack>
  );
}
