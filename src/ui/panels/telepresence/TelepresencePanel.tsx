/**
 * Telepresence tab - immersive, full-screen operator view.
 *
 *   ┌──────────────────────────────────────┐
 *   │ [←]                    [🎤][🔊][⚙]  │  ← glass controls over the feed
 *   │                                      │
 *   │        live camera (cover-fit)       │
 *   │                                      │
 *   │                              ╭──╮    │
 *   │                        HEAD  │✥ │[⊙]│  ← head joystick + recenter
 *   │                              ╰──╯    │
 *   └──────────────────────────────────────┘
 *
 * Native counterpart of the telepresence HF Space: instead of an iframe
 * that re-authenticates and re-dials, it reuses the app's live
 * `RobotSession` (same peer connection, same video cache), so entering
 * the tab is instant.
 *
 * Covers the session chrome (top bar + tab bar) at zIndex 1250 - above
 * the settings overlay (1200), below the connecting / reconnecting /
 * leaving / error covers (1300) so session-level events still win.
 */
import { useCallback, useRef, useState } from 'react';
import { Box, Button, CircularProgress, IconButton, Stack, Typography } from '@mui/material';
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import CenterFocusWeakOutlinedIcon from '@mui/icons-material/CenterFocusWeakOutlined';
import MicOffRoundedIcon from '@mui/icons-material/MicOffRounded';
import MicRoundedIcon from '@mui/icons-material/MicRounded';
import EmojiEmotionsOutlinedIcon from '@mui/icons-material/EmojiEmotionsOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import VolumeOffRoundedIcon from '@mui/icons-material/VolumeOffRounded';
import VolumeUpRoundedIcon from '@mui/icons-material/VolumeUpRounded';

import { useDaemonState } from '@/features/daemon-state';
import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';
import { useTelepresence } from '@/features/telepresence';
import { useEmotionPlayer } from '@/features/emotions';
import { LAYOUT, TYPO } from '@/ui/design/tokens';

import { glassIconButtonSx, glassSurfaceSx } from './glass';
import { Joystick, MoveIcon } from './joystick';
import LiveVideo, { type LiveVideoMode } from './LiveVideo';
import SoundButton from './SoundButton';
import EmotionSheet from './EmotionSheet';
import TelepresenceSettingsSheet from './TelepresenceSettingsSheet';

type DeflectionRef = React.RefObject<{ x: number; y: number }>;

interface TelepresencePanelProps {
  session: RobotSessionHandle;
  onExit: () => void;
  /**
   * Host veto on robot motion: false while the session is tearing down,
   * the on-connect wake animation runs, or the first-wake-up wizard is up.
   */
  allowMotion: boolean;
}

export default function TelepresencePanel({
  session,
  onExit,
  allowMotion,
}: TelepresencePanelProps) {
  const daemon = useDaemonState();
  const live = session.phase === 'live';
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [emotionsOpen, setEmotionsOpen] = useState(false);

  const headRef = useRef<DeflectionRef | null>(null);
  const onHeadRef = useCallback((ref: DeflectionRef) => {
    headRef.current = ref;
  }, []);

  const telepresence = useTelepresence({
    getRobot: session.getRobot,
    active: live,
    allowMotion,
    getHeadDeflection: () => headRef.current?.current ?? null,
  });

  // Low-latency (WebCodecs) video on by default; switchable from the
  // settings sheet so the difference can be felt side by side.
  const [lowLatency, setLowLatency] = useState(true);
  const [videoMode, setVideoMode] = useState<LiveVideoMode>('standard');

  const emotions = useEmotionPlayer({ getRobot: session.getRobot, active: live });

  const asleep = live && telepresence.robotAwake === false;
  const motionEnabled = live && allowMotion && telepresence.robotAwake === true;
  const headDisabledLabel = !live
    ? undefined
    : asleep
      ? 'Asleep'
      : !motionEnabled
        ? 'Waking up…'
        : undefined;

  return (
    <Box
      sx={{
        position: 'fixed',
        inset: 0,
        zIndex: 1250,
        bgcolor: '#000',
        overflow: 'hidden',
        // No text selection / callouts while thumbs are all over the screen.
        userSelect: 'none',
        WebkitUserSelect: 'none',
      }}
    >
      <LiveVideo
        attachVideo={session.attachVideo}
        live={live}
        lowLatency={lowLatency}
        onModeChange={setVideoMode}
      />
      {/* Top + bottom scrims keep the white controls readable over bright scenes. */}
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background:
            'linear-gradient(to bottom, rgba(0,0,0,0.45) 0%, rgba(0,0,0,0) 22%, rgba(0,0,0,0) 70%, rgba(0,0,0,0.5) 100%)',
        }}
      />
      {!live && (
        <Stack
          spacing={1.5}
          sx={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', color: '#fff' }}
        >
          <CircularProgress size={32} sx={{ color: 'rgba(255,255,255,0.8)' }} />
          <Typography sx={{ fontSize: TYPO.sm, color: 'rgba(255,255,255,0.8)' }}>
            {session.phase === 'reacquiring' ? 'Reconnecting to the robot…' : 'Waiting for the robot…'}
          </Typography>
        </Stack>
      )}

      {asleep && (
        <Stack
          spacing={1.5}
          sx={{
            position: 'absolute',
            top: '38%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            alignItems: 'center',
          }}
        >
          <Typography sx={{ fontSize: TYPO.sm, color: 'rgba(255,255,255,0.85)' }}>
            Reachy is asleep
          </Typography>
          <Button
            variant="contained"
            disabled={telepresence.wakingUp || !allowMotion}
            onClick={() => void telepresence.wakeUp()}
            startIcon={
              telepresence.wakingUp ? <CircularProgress size={16} color="inherit" /> : undefined
            }
          >
            {telepresence.wakingUp ? 'Waking up…' : 'Wake up'}
          </Button>
        </Stack>
      )}

      <Stack
        direction="row"
        sx={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: `calc(${LAYOUT.safeAreaBottom} + 28px)`,
          px: 2.5,
          alignItems: 'flex-end',
          justifyContent: 'flex-end',
        }}
      >
        <Joystick
          onDeflectionRef={onHeadRef}
          enabled={motionEnabled}
          size={128}
          label="Head"
          disabledLabel={headDisabledLabel}
          gamepadStick="right"
          thumbIcon={<MoveIcon />}
        >
          <IconButton
            aria-label="Recenter head"
            onClick={telepresence.recenterHead}
            sx={[
              glassIconButtonSx,
              {
                position: 'absolute',
                top: -52,
                right: 0,
                opacity: telepresence.motion.headOffCenter ? 1 : 0,
                pointerEvents: telepresence.motion.headOffCenter ? 'auto' : 'none',
                transition: 'opacity 200ms ease',
              },
            ]}
          >
            <CenterFocusWeakOutlinedIcon />
          </IconButton>
        </Joystick>
      </Stack>

      {/* Top controls. */}
      <Stack
        direction="row"
        spacing={1}
        sx={{
          position: 'absolute',
          top: `calc(${LAYOUT.safeAreaTop} + 12px)`,
          left: 16,
          right: 16,
          alignItems: 'center',
        }}
      >
        <IconButton aria-label="Leave telepresence" onClick={onExit} sx={glassIconButtonSx}>
          <ArrowBackRoundedIcon />
        </IconButton>
        <Box sx={{ flex: 1 }} />
        <SoundButton
          on={telepresence.talkEnabled}
          pending={telepresence.talkPending}
          onToggle={() => telepresence.setTalkEnabled(!telepresence.talkEnabled)}
          iconOn={<MicRoundedIcon />}
          iconOff={<MicOffRoundedIcon />}
          ariaLabel={telepresence.talkEnabled ? 'Mute my microphone' : 'Talk through the robot'}
          volume={daemon.speakerVolume}
          onVolumeChange={daemon.setSpeakerVolume}
          volumeLabel="Robot speaker"
          disabled={!live || telepresence.talkPending}
        />
        <SoundButton
          on={telepresence.listenEnabled}
          onToggle={() => telepresence.setListenEnabled(!telepresence.listenEnabled)}
          iconOn={<VolumeUpRoundedIcon />}
          iconOff={<VolumeOffRoundedIcon />}
          ariaLabel={telepresence.listenEnabled ? 'Mute the robot' : 'Listen to the robot'}
          volume={daemon.microphoneVolume}
          onVolumeChange={daemon.setMicrophoneVolume}
          volumeLabel="Robot mic"
          disabled={!live}
        />
        <IconButton
          aria-label="Play an emotion"
          onClick={() => setEmotionsOpen(true)}
          disabled={!live}
          sx={glassIconButtonSx}
        >
          <EmojiEmotionsOutlinedIcon />
        </IconButton>
        <IconButton aria-label="Telepresence settings" onClick={() => setSettingsOpen(true)} sx={glassIconButtonSx}>
          <SettingsOutlinedIcon />
        </IconButton>
      </Stack>

      {telepresence.talkError && (
        <Typography
          sx={[
            glassSurfaceSx,
            {
              position: 'absolute',
              top: `calc(${LAYOUT.safeAreaTop} + 68px)`,
              right: 16,
              maxWidth: 260,
              borderRadius: 2,
              px: 1.5,
              py: 1,
              fontSize: TYPO.xs,
            },
          ]}
        >
          Microphone unavailable: {telepresence.talkError}
        </Typography>
      )}

      <EmotionSheet
        open={emotionsOpen}
        onClose={() => setEmotionsOpen(false)}
        player={emotions}
        blockedReason={
          !live
            ? 'Waiting for the robot…'
            : asleep
              ? 'Reachy is asleep - wake it up first.'
              : !allowMotion
                ? 'Reachy is busy waking up…'
                : null
        }
      />

      <TelepresenceSettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        telepresence={telepresence}
        motionEnabled={motionEnabled}
        lowLatency={lowLatency}
        onLowLatencyChange={setLowLatency}
        videoMode={videoMode}
        audioReady={session.hasReachedReady && live}
      />
    </Box>
  );
}
