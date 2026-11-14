/**
 * Side sheet behind the telepresence cog (right edge of the landscape
 * stage, so the video stays visible on the left).
 *
 *   Pose      head roll · base yaw · left / right antenna · reset
 *   Video     low-latency (WebCodecs) switch
 *   Audio     robot speaker volume · robot mic gain
 *
 * Pose sliders show the controller's TARGETS: the base slider moves on
 * its own when the head joystick drags the base past the head's leash.
 */
import { Box, Button, Drawer, Stack, Typography } from '@mui/material';
import RestartAltRoundedIcon from '@mui/icons-material/RestartAltRounded';

import { TELEPRESENCE_LIMITS, type TelepresenceHandle } from '@/features/telepresence';
import { useDaemonState } from '@/features/daemon-state';
import { OutlinedSwitch } from '@/ui/design/OutlinedSwitch';
import { FONT_WEIGHT, TYPO } from '@/ui/design/tokens';
import AudioControlCard from '@/ui/widgets/audio-controls/AudioControlCard';

import type { LiveVideoMode } from './LiveVideo';
import { stageSheetProps } from './sheet';
import { useStage } from './stage';
import StageSlider from './StageSlider';

interface TelepresenceSettingsSheetProps {
  open: boolean;
  onClose: () => void;
  telepresence: TelepresenceHandle;
  audioReady: boolean;
  /** Robot awake + host allows motion. Pose controls are inert otherwise. */
  motionEnabled: boolean;
  lowLatency: boolean;
  onLowLatencyChange: (enabled: boolean) => void;
  videoMode: LiveVideoMode;
}

const VIDEO_MODE_LABEL: Record<LiveVideoMode, string> = {
  'low-latency': 'Active: frames are shown as soon as they are decoded.',
  starting: 'Starting (waiting for a keyframe)…',
  standard: 'Off: standard browser playback (adds buffering).',
  unsupported: 'Not supported on this device: using standard playback.',
};

export default function TelepresenceSettingsSheet({
  open,
  onClose,
  telepresence,
  audioReady,
  motionEnabled,
  lowLatency,
  onLowLatencyChange,
  videoMode,
}: TelepresenceSettingsSheetProps) {
  const poseDisabled = !motionEnabled;
  const daemon = useDaemonState();
  const { targets } = telepresence.motion;
  const L = TELEPRESENCE_LIMITS;
  const stage = useStage();

  return (
    <Drawer open={open} onClose={onClose} {...stageSheetProps(stage)}>
      <Stack spacing={3}>
        <SheetSection
          title="Pose"
          action={
            <Button
              size="small"
              startIcon={<RestartAltRoundedIcon />}
              onClick={telepresence.resetPose}
              disabled={poseDisabled}
            >
              Reset
            </Button>
          }
        >
          <PoseSlider
            label="Head roll"
            value={targets.roll}
            limit={L.rollDeg}
            onChange={telepresence.setRollTarget}
            disabled={poseDisabled}
          />
          <PoseSlider
            label="Base yaw"
            value={targets.bodyYaw}
            limit={L.bodyYawDeg}
            onChange={telepresence.setBodyYawTarget}
            disabled={poseDisabled}
          />
          <PoseSlider
            label="Left antenna"
            value={targets.antennaLeft}
            limit={L.antennaDeg}
            onChange={(v) => telepresence.setAntennasTarget(targets.antennaRight, v)}
            disabled={poseDisabled}
          />
          <PoseSlider
            label="Right antenna"
            value={targets.antennaRight}
            limit={L.antennaDeg}
            onChange={(v) => telepresence.setAntennasTarget(v, targets.antennaLeft)}
            disabled={poseDisabled}
          />
        </SheetSection>

        <SheetSection title="Video">
          <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography sx={{ fontSize: TYPO.md, fontWeight: FONT_WEIGHT.semibold }}>
                Low-latency video
              </Typography>
              <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary' }}>
                {VIDEO_MODE_LABEL[videoMode]}
              </Typography>
            </Box>
            <OutlinedSwitch
              checked={lowLatency}
              onChange={(_, checked) => onLowLatencyChange(checked)}
              slotProps={{ input: { 'aria-label': 'Low-latency video' } }}
            />
          </Stack>
        </SheetSection>

        <SheetSection title="Robot audio" hint="Tip: long-press a sound button for quick volume.">
          <AudioControlCard
            kind="speaker"
            value={daemon.speakerVolume ?? 50}
            onChange={daemon.setSpeakerVolume}
            onToggleMute={daemon.toggleSpeakerMute}
            disabled={!audioReady}
            SliderComponent={StageSlider}
          />
          <AudioControlCard
            kind="microphone"
            value={daemon.microphoneVolume ?? 50}
            onChange={daemon.setMicrophoneVolume}
            onToggleMute={daemon.toggleMicrophoneMute}
            disabled={!audioReady}
            SliderComponent={StageSlider}
          />
        </SheetSection>
      </Stack>
    </Drawer>
  );
}

function SheetSection({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Stack spacing={1}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', minHeight: 30 }}>
        <Typography
          sx={{
            fontSize: TYPO.tiny,
            fontWeight: FONT_WEIGHT.bold,
            letterSpacing: '1px',
            textTransform: 'uppercase',
            color: 'text.secondary',
          }}
        >
          {title}
        </Typography>
        {action}
      </Stack>
      {children}
      {hint && <Typography sx={{ fontSize: TYPO.tiny, color: 'text.secondary' }}>{hint}</Typography>}
    </Stack>
  );
}

function PoseSlider({
  label,
  value,
  limit,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  limit: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  return (
    <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
      <Typography sx={{ fontSize: TYPO.sm, width: 100, flexShrink: 0 }}>{label}</Typography>
      <StageSlider
        size="small"
        aria-label={label}
        value={value}
        min={-limit}
        max={limit}
        step={1}
        marks={[{ value: 0 }]}
        track={false}
        disabled={disabled}
        onChange={(_, v) => onChange(v as number)}
        onDoubleClick={() => onChange(0)}
      />
      <Typography
        sx={{ fontSize: TYPO.xs, width: 40, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
      >
        {Math.round(value)}°
      </Typography>
    </Stack>
  );
}
