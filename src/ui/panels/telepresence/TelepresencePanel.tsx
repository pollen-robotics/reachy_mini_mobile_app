/**
 * Telepresence tab - immersive, full-screen operator view.
 *
 *   ┌──────────────────────────────────────┐
 *   │ [←]                    [🎤][🔊][⚙]  │  ← glass controls over the feed
 *   │                                      │
 *   │        live camera (cover-fit)       │
 *   │                                      │
 *   │  ╭──╮                        ╭──╮    │
 *   │  │⎈ │ WHEELS          HEAD  │✥ │[⊙]│  ← overboard / head joysticks
 *   │  ╰──╯                        ╰──╯    │
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
 *
 * Manual overboard mode swaps the whole view for `<ManualOverboardView>`;
 * the screen owns the matching session release / reacquire.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Button, CircularProgress, IconButton, Stack, Typography } from '@mui/material';
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import CenterFocusWeakOutlinedIcon from '@mui/icons-material/CenterFocusWeakOutlined';
import MicOffRoundedIcon from '@mui/icons-material/MicOffRounded';
import MicRoundedIcon from '@mui/icons-material/MicRounded';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import VolumeOffRoundedIcon from '@mui/icons-material/VolumeOffRounded';
import VolumeUpRoundedIcon from '@mui/icons-material/VolumeUpRounded';

import { useDaemonState } from '@/features/daemon-state';
import { useOverboard } from '@/features/overboard';
import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';
import { useTelepresence } from '@/features/telepresence';
import { FONT_WEIGHT, LAYOUT, TYPO } from '@/ui/design/tokens';

import { WHEELS_COLOR, glassIconButtonSx, glassSurfaceSx } from './glass';
import { Joystick, MoveIcon, WheelsIcon } from './joystick';
import ManualOverboardView from './ManualOverboardView';
import SoundButton from './SoundButton';
import TelepresenceSettingsSheet from './TelepresenceSettingsSheet';

type DeflectionRef = React.RefObject<{ x: number; y: number }>;

interface TelepresencePanelProps {
  session: RobotSessionHandle;
  manualMode: boolean;
  onManualModeChange: (manual: boolean) => void;
  onExit: () => void;
  /**
   * Host veto on robot motion: false while the session is tearing down,
   * the on-connect wake animation runs, or the first-wake-up wizard is up.
   */
  allowMotion: boolean;
}

export default function TelepresencePanel({
  session,
  manualMode,
  onManualModeChange,
  onExit,
  allowMotion,
}: TelepresencePanelProps) {
  const daemon = useDaemonState();
  const live = session.phase === 'live';
  const [settingsOpen, setSettingsOpen] = useState(false);

  const headRef = useRef<DeflectionRef | null>(null);
  const wheelsRef = useRef<DeflectionRef | null>(null);
  const onHeadRef = useCallback((ref: DeflectionRef) => {
    headRef.current = ref;
  }, []);
  const onWheelsRef = useCallback((ref: DeflectionRef) => {
    wheelsRef.current = ref;
  }, []);

  const telepresence = useTelepresence({
    getRobot: session.getRobot,
    active: live && !manualMode,
    allowMotion,
    getHeadDeflection: () => headRef.current?.current ?? null,
  });
  const overboard = useOverboard({
    mode: manualMode ? 'ble' : 'webrtc',
    active: manualMode || live,
    getRobot: session.getRobot,
    getDeflection: () => wheelsRef.current?.current ?? null,
  });

  // Camera feed. Re-attached whenever the session comes back to `live`
  // (after a reacquire / recovery the cache replays the fresh stream).
  // Forced muted: robot audio plays through the telepresence audio
  // element, and the SDK would otherwise mirror its own mute flag here.
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const { attachVideo } = session;
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !live || manualMode) return;
    const detach = attachVideo(el);
    el.muted = true;
    const keepMuted = () => {
      if (!el.muted) el.muted = true;
    };
    el.addEventListener('volumechange', keepMuted);
    return () => {
      el.removeEventListener('volumechange', keepMuted);
      detach();
    };
  }, [live, manualMode, attachVideo]);

  const asleep = live && telepresence.robotAwake === false;
  const motionEnabled = live && allowMotion && telepresence.robotAwake === true;
  const headDisabledLabel = !live
    ? undefined
    : asleep
      ? 'Asleep'
      : !motionEnabled
        ? 'Waking up…'
        : undefined;

  // Manual mode releases the session: glide the pose home first so the
  // release doesn't cut a head / base motion mid-way.
  const [switchingMode, setSwitchingMode] = useState(false);
  const handleManualModeChange = async (manual: boolean) => {
    if (switchingMode) return;
    if (manual) {
      setSwitchingMode(true);
      try {
        await telepresence.park();
      } finally {
        setSwitchingMode(false);
      }
    }
    onManualModeChange(manual);
  };

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
      {manualMode ? (
        <ManualOverboardView
          ble={overboard.ble}
          stats={overboard.stats}
          onDeflectionRef={onWheelsRef}
          onRetry={overboard.connectBle}
        />
      ) : (
        <>
          <Box
            component="video"
            ref={videoRef}
            autoPlay
            playsInline
            muted
            sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
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
          {switchingMode && (
            <Stack sx={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' }}>
              <CircularProgress size={32} sx={{ color: 'rgba(255,255,255,0.8)' }} />
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
              justifyContent: 'space-between',
            }}
          >
            <Joystick
              onDeflectionRef={onWheelsRef}
              enabled={live}
              size={128}
              label="Wheels"
              gamepadStick="left"
              thumbIcon={<WheelsIcon />}
              thumbColor={WHEELS_COLOR}
            />
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
        </>
      )}

      {/* Top controls - shared by both modes. */}
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
        {manualMode && (
          <Box sx={[glassSurfaceSx, { borderRadius: 999, px: 1.5, py: 0.5 }]}>
            <Typography sx={{ fontSize: TYPO.xs, fontWeight: FONT_WEIGHT.semibold }}>
              Manual overboard
            </Typography>
          </Box>
        )}
        <Box sx={{ flex: 1 }} />
        {!manualMode && (
          <>
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
          </>
        )}
        <IconButton aria-label="Telepresence settings" onClick={() => setSettingsOpen(true)} sx={glassIconButtonSx}>
          <SettingsOutlinedIcon />
        </IconButton>
      </Stack>

      {telepresence.talkError && !manualMode && (
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

      <TelepresenceSettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        telepresence={telepresence}
        manualMode={manualMode}
        onManualModeChange={(manual) => {
          setSettingsOpen(false);
          void handleManualModeChange(manual);
        }}
        motionEnabled={motionEnabled}
        overboardStats={overboard.stats}
        audioReady={session.hasReachedReady && live}
      />
    </Box>
  );
}
