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
 *   │  LOGS                            │
 *   │  ┌────────────────────────────┐  │  ← placeholder for the upcoming
 *   │  │                            │  │     `subscribe_logs` UI (see
 *   │  │       Coming soon          │  │     `docs/WEBRTC_LOGS.md`).
 *   │  │                            │  │     Grows to fill the rest of
 *   │  └────────────────────────────┘  │     the available vertical space.
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
import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';
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
        }}
      >
        {/* The vertical layout (flex column) + the top/bottom
            paddings live INSIDE this Stack, NOT on the scroll
            container above. This is deliberate:
              1. iOS WebKit drops `padding-bottom` on a flex container
                 that also has `overflow: auto` when a child uses
                 `flex: 1` — the padding is computed away during the
                 flex pass and the bottom gap silently disappears,
                 no matter how big the value is.
              2. Putting flex + padding inside the inner Stack keeps
                 the scroll Box a plain block container, which lets
                 padding render predictably across browsers.
              3. `minHeight: '100%'` ensures the Stack still fills the
                 visible viewport when content is short, so the
                 trailing Logs section's `flex: 1` has somewhere to
                 grow into. */}
        <Stack
          spacing={3}
          sx={{
            ...COLUMN_SX,
            display: 'flex',
            flexDirection: 'column',
            minHeight: '100%',
            pt: 1,
            pb: 3,
          }}
        >
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

          {/* Logs section. Placeholder card pinned to the bottom of
              the tab, eating the rest of the vertical space so the
              scrollable area never has dead empty grey at the
              bottom. Wired up to `subscribe_logs` once the daemon
              PR lands (see `docs/WEBRTC_LOGS.md`); until then we
              render a discreet "Coming soon" so the slot is
              visible and intentional. */}
          {/* `minHeight: 80` rather than 160 so the placeholder can
              shrink on small phones (iPhone SE-class viewports) and
              keep the camera + audio + logs trio scrollbar-free at
              the default zoom. When the real `LogsConsole` lands
              we'll bump this back up since virtualised log lists
              actually need the room. */}
          <Section label="Logs" fill>
            <Box
              sx={(theme) => ({
                flex: 1,
                minHeight: 80,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: `${RADIUS.lg}px`,
                border: `1px solid ${theme.palette.divider}`,
                bgcolor: theme.palette.background.paper,
              })}
            >
              <Typography
                sx={{
                  fontSize: TYPO.sm,
                  color: 'text.secondary',
                }}
              >
                Coming soon
              </Typography>
            </Box>
          </Section>
        </Stack>
      </Box>
    </Stack>
  );
}

/**
 * Section block: tiny uppercase label above its child(ren). Mirrors
 * the AudioControlCard's outside-label convention so the camera and
 * audio sections feel typographically aligned.
 *
 * `fill`: when true the section grows to consume any leftover
 * vertical space inside its parent flex column, and wraps `children`
 * in a `flex: 1` container so a single child Box can stretch with
 * `flex: 1` of its own. Used by the trailing Logs placeholder so it
 * pins to the bottom and fills the gap below the audio cards
 * regardless of viewport height.
 */
function Section({
  label,
  children,
  fill = false,
}: {
  label: string;
  children: React.ReactNode;
  fill?: boolean;
}) {
  return (
    <Stack
      spacing={1}
      sx={fill ? { flex: 1, minHeight: 0 } : undefined}
    >
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
      {fill ? (
        <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>{children}</Box>
      ) : (
        children
      )}
    </Stack>
  );
}
