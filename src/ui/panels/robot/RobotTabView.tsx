/**
 * Robot tab body.
 *
 *   ┌──────────────────────────────────────┐
 *   │                                      │
 *   │  ┌────────────────────────────────┐  │
 *   │  │ CAMERA   view from Reachy      │  │  ← uniform header strip
 *   │  ├────────────────────────────────┤  │     (label · subtitle · actions)
 *   │  │ ● LIVE                         │  │
 *   │  │      <video, 4:3>      ╭──╮    │  │  ← head joystick overlay,
 *   │  │                        │··│    │  │     bottom-right of the
 *   │  │                        ╰──╯    │  │     camera body
 *   │  └────────────────────────────────┘  │
 *   │                                      │
 *   │  ┌────────────────────────────────┐  │
 *   │  │ AUDIO   speaker · microphone   │  │
 *   │  ├────────────────────────────────┤  │
 *   │  │ [🔊]●─●  100   [🎤]●─●  100   │  │  ← single row, side-by-side
 *   │  └────────────────────────────────┘  │
 *   │                                      │
 *   │  ┌────────────────────────────────┐  │
 *   │  │ LOGS   live journal       [⧉] │  │  ← copy lives in the panel
 *   │  ├────────────────────────────────┤  │     header's actions slot
 *   │  │ Daemon started …  12:35:34     │  │
 *   │  │ ...                            │  │
 *   │  └────────────────────────────────┘  │
 *   │                                      │
 *   └──────────────────────────────────────┘
 *
 * Uniform card system
 * ───────────────────
 * Each section is a `<RobotPanel>` with the same anatomy: tiny
 * uppercase title + optional descriptive subtitle + optional
 * actions slot (icons), divider, then content. The point is
 * consistency: a glance at the tab tells the user "I'm seeing
 * three labelled sections, each with one job"; new sections
 * (battery, settings, shortcuts) drop in without re-deciding
 * the chrome.
 *
 * Per-section content
 * ───────────────────
 *   - Camera  : 4:3 video frame + head joystick overlay. Body
 *               opts out of the panel's default padding because
 *               the video paints edge-to-edge.
 *   - Audio   : speaker + microphone sliders side-by-side in one
 *               row inside the panel body (a single AUDIO panel,
 *               NOT two). State is read / written via the shared
 *               `useDaemonState()` context (mounted upstream by
 *               `RobotSessionScreen`).
 *   - Logs    : the daemon's WebRTC log tail (see
 *               `docs/WEBRTC_LOGS.md`). Body opts out of padding
 *               because the console paints its own terminal-ish
 *               surface; the copy button lives in the panel's
 *               actions slot.
 *
 * Pure consumer of the session handle: takes only the slice of
 * `RobotSessionHandle` it needs (`Pick`). Mirrors the desktop's
 * "left column" feature set (camera + audio + log tail) plus a
 * mobile-native joystick for manual head steering.
 *
 * Layout convention is shared with the Apps tab:
 *   - parent `Stack` escapes the host column constraints via the
 *     `100vw` + `calc(50% - 50vw)` trick so the scrollable body
 *     spans flush to the viewport edges,
 *   - inside, every row re-applies `COLUMN_SX` so cards stay on
 *     a single centred column.
 */
import { Box, IconButton, Stack, Tooltip } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { useCallback } from 'react';

import VideoFeed from '@/ui/widgets/video-feed/VideoFeed';
import AudioControlCard from '@/ui/widgets/audio-controls/AudioControlCard';
import { HeadJoystickOverlay } from '@/ui/widgets/head-control';
import { DaemonLogConsole } from '@/ui/widgets/daemon-logs';
import { RobotPanel } from '@/ui/widgets/robot-panel';
import {
  formatEntriesForCopy,
  useDaemonLogs,
} from '@/features/daemon-logs';
import { useDaemonState } from '@/features/daemon-state';
import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';
import { LAYOUT } from '@/ui/design/tokens';

interface RobotTabViewProps {
  /**
   * Slice of the session the tab needs. Typed via `Pick` so the
   * dependency surface is explicit at the call site and the view
   * can be unit-tested with a fake handle. The daemon-touching
   * methods (volumes, sound playback, version) are read / written
   * via the shared `useDaemonState()` context (mounted in
   * `RobotSessionScreen`), so we only need the camera + joystick
   * + log subscription on the session here.
   */
  session: Pick<
    RobotSessionHandle,
    'attachVideo' | 'setHeadRpyDeg' | 'subscribeLogs'
  >;
  /**
   * Becomes `true` once the engine has reached `ready` for the
   * first time. Used to disable the audio cards while the daemon
   * round-trip can't yet land, and to gate the daemon log
   * subscription. The camera feed itself decides its own offline
   * state from the SDK's track, so it doesn't need this gate.
   */
  isLive: boolean;
}

const COLUMN_SX = {
  width: '100%',
  maxWidth: LAYOUT.contentMaxWidth,
  mx: 'auto',
  px: 3,
} as const;

/**
 * Floor for the LOGS panel height. The panel is sized via `flex: 1`
 * so it eats whatever vertical space is left after the camera +
 * audio + paddings, but on very tall content (or weird viewport
 * proportions) we still want to guarantee a few visible log rows
 * - landing on a 1-row-tall logs panel after a short camera frame
 * would defeat the "you can glance at the logs" promise of the
 * tab. 120 px = roughly 4 rows of LogLineRow, which is enough to
 * read a typical burst.
 */
const LOGS_MIN_HEIGHT_PX = 120;

export default function RobotTabView({ session, isLive }: RobotTabViewProps) {
  // Volumes + version live in the shared daemon-state context.
  // While the engine isn't live yet (`isLive=false`), every
  // readable field is `null`; the audio cards fall back to the
  // slider's default of 50 (handled below via `?? 50`) and stay
  // disabled, so the user can't drag a slider against a daemon
  // that won't answer.
  const daemon = useDaemonState();

  // Daemon log buffer. Lives in the host (not in
  // `<DaemonLogConsole>`) so the copy button can sit in the
  // RobotPanel's actions slot without us having to subscribe twice
  // or thread callbacks down through props.
  const logs = useDaemonLogs({ session, enabled: isLive });

  const handleCopyLogs = useCallback(async () => {
    const text = formatEntriesForCopy(logs.entries);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.warn('[robot-tab] clipboard.writeText failed:', err);
    }
  }, [logs.entries]);

  return (
    <Stack
      sx={{
        flex: 1,
        minHeight: 0,
        // Full-bleed escape hatch (see AppsTabView for the
        // long-form rationale): the host column is `maxWidth: 420`
        // inside a `Stack px: 3`, this pair pulls us back out to
        // the viewport edges.
        width: '100vw',
        mx: 'calc(50% - 50vw)',
        overflow: 'hidden',
      }}
    >
      {/* No outer scroll on this tab: the camera + audio + logs
          stack is sized to fit the viewport via flex column, with
          the LOGS panel eating the leftover space (`flex: 1`).
          The user's mental model is "this is a dashboard, not a
          long page" — they shouldn't need to scroll the page to
          see all three sections. The logs panel itself scrolls
          internally for older entries (cap 100). */}
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <Stack
          spacing={3}
          sx={{
            ...COLUMN_SX,
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            pt: 4,
            pb: 4,
          }}
        >
          {/* CAMERA panel. No header strip: the `<CameraBadge>`
              overlay rendered by `<VideoFeed>` already labels
              the section in-frame ("Camera · View from Reachy"
              pip), so an outer header would just duplicate the
              label. Body has no padding so the 4:3 video can
              paint edge-to-edge; the joystick is anchored
              absolute within the body for the bottom-right
              corner. */}
          <RobotPanel noBodyChrome>
            <Box
              sx={{
                position: 'relative',
                width: '100%',
                aspectRatio: '4 / 3',
              }}
            >
              <VideoFeed session={session} />
              {/* Head joystick anchored bottom-right of the camera
                  frame. Mounting starts the velocity controller;
                  unmounting (e.g. user navigates away from this
                  tab) triggers a smooth recenter back to (0, 0).
                  Gated on `isLive` so the joystick is faded and
                  non-interactive until the engine has reached
                  `ready` for the first time. */}
              <HeadJoystickOverlay session={session} enabled={isLive} />
            </Box>
          </RobotPanel>

          {/* SPEAKER + MICROPHONE panels. The earlier draft
              wrapped both cards in a single "Audio" panel, but
              the umbrella header just duplicated what each
              card's icon already says. We now ship one panel
              per device, side-by-side in a flex row, so each
              column carries its own header and the device name
              lives in chrome (consistent with `<RobotPanel>`'s
              "title + content" rhythm) instead of being implicit
              in an icon. */}
          <Stack direction="row" spacing={2.5} sx={{ width: '100%' }}>
            <Box sx={{ flex: 1, minWidth: 0, display: 'flex' }}>
              <RobotPanel title="Speaker" sx={{ flex: 1 }}>
                <AudioControlCard
                  kind="speaker"
                  value={daemon.speakerVolume ?? 50}
                  onChange={daemon.setSpeakerVolume}
                  onToggleMute={daemon.toggleSpeakerMute}
                  disabled={!isLive}
                />
              </RobotPanel>
            </Box>
            <Box sx={{ flex: 1, minWidth: 0, display: 'flex' }}>
              <RobotPanel title="Microphone" sx={{ flex: 1 }}>
                <AudioControlCard
                  kind="microphone"
                  value={daemon.microphoneVolume ?? 50}
                  onChange={daemon.setMicrophoneVolume}
                  onToggleMute={daemon.toggleMicrophoneMute}
                  disabled={!isLive}
                />
              </RobotPanel>
            </Box>
          </Stack>

          {/* LOGS panel. Eats the leftover vertical space via
              `flex: 1, minHeight: 0` so the page never scrolls:
              camera (4:3) + audio (compact) + logs (the rest)
              tile the viewport exactly. Floor of 120 px protects
              against pathological viewports where the logs panel
              would collapse to a couple of pixels.
              Body has no padding so the terminal-style console
              paints its own dim bg edge-to-edge; the copy button
              lives in the panel's actions slot. */}
          <RobotPanel
            title="Logs"
            subtitle="Live daemon journal"
            actions={
              <Tooltip title="Copy all lines to clipboard" arrow>
                <span>
                  <IconButton
                    onClick={handleCopyLogs}
                    disabled={logs.entries.length === 0}
                    size="small"
                    sx={{ width: 24, height: 24, p: 0.25 }}
                  >
                    <ContentCopyIcon sx={{ fontSize: 12 }} />
                  </IconButton>
                </span>
              </Tooltip>
            }
            noBodyChrome
            sx={{ flex: 1, minHeight: LOGS_MIN_HEIGHT_PX }}
          >
            <DaemonLogConsole
              entries={logs.entries}
              status={logs.status}
              errorMessage={logs.errorMessage}
              enabled={isLive}
            />
          </RobotPanel>
        </Stack>
      </Box>
    </Stack>
  );
}
