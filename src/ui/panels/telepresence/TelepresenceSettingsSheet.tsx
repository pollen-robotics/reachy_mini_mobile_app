/**
 * Bottom sheet behind the telepresence cog.
 *
 *   Pose      head roll · base yaw · left / right antenna · reset
 *   Audio     robot speaker volume · robot mic gain
 *   Overboard manual (Bluetooth) mode switch + WebRTC pipe counters
 *
 * Pose sliders show the controller's TARGETS: the base slider moves on
 * its own when the head joystick drags the base past the head's leash.
 */
import { Box, Button, Drawer, Slider, Stack, Typography } from '@mui/material';
import RestartAltRoundedIcon from '@mui/icons-material/RestartAltRounded';

import type { HoverboardStatus, OverboardLinkStats } from '@/features/overboard';
import { TELEPRESENCE_LIMITS, type TelepresenceHandle } from '@/features/telepresence';
import { useDaemonState } from '@/features/daemon-state';
import { OutlinedSwitch } from '@/ui/design/OutlinedSwitch';
import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';
import AudioControlCard from '@/ui/widgets/audio-controls/AudioControlCard';

import type { LiveVideoMode } from './LiveVideo';

interface TelepresenceSettingsSheetProps {
  open: boolean;
  onClose: () => void;
  telepresence: TelepresenceHandle;
  manualMode: boolean;
  onManualModeChange: (manual: boolean) => void;
  overboardStats: OverboardLinkStats;
  /** Last daemon hoverboard status (null = no reply / unsupported). */
  baseStatus: HoverboardStatus | null;
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
  manualMode,
  onManualModeChange,
  overboardStats,
  baseStatus,
  audioReady,
  motionEnabled,
  lowLatency,
  onLowLatencyChange,
  videoMode,
}: TelepresenceSettingsSheetProps) {
  const poseDisabled = manualMode || !motionEnabled;
  const daemon = useDaemonState();
  const { targets } = telepresence.motion;
  const L = TELEPRESENCE_LIMITS;

  return (
    <Drawer
      anchor="bottom"
      open={open}
      onClose={onClose}
      // Above the full-screen telepresence layer (1250), below the
      // session transition covers (1300).
      sx={{ zIndex: 1280 }}
      slotProps={{
        paper: {
          sx: {
            borderTopLeftRadius: RADIUS.xxl,
            borderTopRightRadius: RADIUS.xxl,
            maxHeight: '80vh',
            px: 3,
            pt: 1.5,
            pb: 'calc(var(--inset-bottom, env(safe-area-inset-bottom, 0px)) + 20px)',
          },
        },
      }}
    >
      <Box sx={{ width: 36, height: 4, borderRadius: 2, bgcolor: 'divider', mx: 'auto', mb: 2 }} />
      <Stack spacing={3} sx={{ maxWidth: 480, width: '100%', mx: 'auto' }}>
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
              disabled={manualMode}
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
            disabled={!audioReady || manualMode}
          />
          <AudioControlCard
            kind="microphone"
            value={daemon.microphoneVolume ?? 50}
            onChange={daemon.setMicrophoneVolume}
            onToggleMute={daemon.toggleMicrophoneMute}
            disabled={!audioReady || manualMode}
          />
        </SheetSection>

        <SheetSection title="Overboard">
          <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography sx={{ fontSize: TYPO.md, fontWeight: FONT_WEIGHT.semibold }}>
                Manual mode (Bluetooth)
              </Typography>
              <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary' }}>
                Drive the base directly from the phone. Stops video, audio and head control
                and releases the robot.
              </Typography>
            </Box>
            <OutlinedSwitch
              checked={manualMode}
              onChange={(_, checked) => onManualModeChange(checked)}
              slotProps={{ input: { 'aria-label': 'Overboard manual mode' } }}
            />
          </Stack>
          {!manualMode && (
            <Typography
              sx={{
                fontSize: TYPO.tiny,
                color: 'text.secondary',
                fontFamily: 'monospace',
                whiteSpace: 'pre-line',
                overflowWrap: 'anywhere',
              }}
            >
              {formatBaseStatus(overboardStats, baseStatus)}
            </Typography>
          )}
        </SheetSection>
      </Stack>
    </Drawer>
  );
}

function formatBaseStatus(stats: OverboardLinkStats, s: HoverboardStatus | null): string {
  const lines = [`WebRTC · drive frames sent ${stats.sent}`];
  if (!s) return [...lines, 'daemon: no hoverboard status (unsupported or no reply)'].join('\n');
  const link = s.link.connected
    ? `${s.link.kind ?? '?'} ${s.link.target ?? ''}`.trim()
    : s.link.connecting
      ? 'connecting…'
      : `offline${s.link.error ? ` (${s.link.error})` : ''}`;
  lines.push(`link · ${link}`);
  lines.push(
    `firmware · ${s.firmware.acks ? 'acks' : 'silent'}${s.telemetry ? ` · ${s.telemetry.state} · tilt ${s.telemetry.tilt_deg.toFixed(1)}°` : ''}`,
  );
  lines.push(
    `drive · T${s.drive.throttle} R${s.drive.turn}${s.drive.zeroed_by_deadman ? ' · zeroed by deadman' : ''}`,
  );
  return lines.join('\n');
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
      <Slider
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
