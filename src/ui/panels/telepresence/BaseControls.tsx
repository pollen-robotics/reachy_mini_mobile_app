/**
 * Wheeled-base controls floating above the wheels joystick:
 *
 *   ┌──────────────────────┐
 *   │ ● Balancing · 2.1°   │   ← link + firmware state
 *   │ [ Sit ]   [ STOP ]   │   ← lifecycle action + emergency stop
 *   └──────────────────────┘
 *
 * STOP is shown whenever the base is connected: it cuts the motors at
 * once (firmware E1), which is also the way out of a lift-off in the air.
 */
import { Box, Button, CircularProgress, Stack, Typography } from '@mui/material';

import type { BasePhase, HoverboardBaseHandle } from '@/features/overboard';
import { FONT_WEIGHT, TYPO } from '@/ui/design/tokens';

import { glassSurfaceSx } from './glass';

const PHASE_LABEL: Record<BasePhase, string> = {
  unavailable: 'Base: not supported',
  offline: 'Base offline',
  connecting: 'Connecting…',  // also the daemon's own Bluetooth re-dial
  sitting: 'Base resting',
  lifting: 'Lifting off…',
  balancing: 'Balancing',
  stopping: 'Sitting down…',
};

const PHASE_DOT: Record<BasePhase, string> = {
  unavailable: 'rgba(255,255,255,0.35)',
  offline: '#ef4444',
  connecting: '#f59e0b',
  sitting: '#f59e0b',
  lifting: '#22c55e',
  balancing: '#22c55e',
  stopping: '#f59e0b',
};

const glassButtonSx = {
  ...glassSurfaceSx,
  minWidth: 0,
  px: 1.5,
  py: 0.5,
  borderRadius: 999,
  fontSize: TYPO.xs,
  fontWeight: FONT_WEIGHT.semibold,
  textTransform: 'none',
  '&:hover': { bgcolor: 'rgba(0, 0, 0, 0.5)' },
  '&.Mui-disabled': { color: 'rgba(255, 255, 255, 0.4)' },
} as const;

export default function BaseControls({ base, disabled }: { base: HoverboardBaseHandle; disabled: boolean }) {
  const { pending, status, error } = base;
  // The link only reports `connecting` once the daemon starts on it.
  const phase = pending === 'connect' && base.phase === 'offline' ? 'connecting' : base.phase;
  const connected = status?.link.connected ?? false;
  const tilt = status?.telemetry?.tilt_deg;
  const busy = pending !== null || disabled;

  const action: { label: string; command: 'connect' | 'enable' | 'sit' } | null =
    phase === 'offline'
      ? { label: 'Connect', command: 'connect' }
      : phase === 'sitting'
        ? { label: 'Stand up', command: 'enable' }
        : phase === 'balancing' || phase === 'lifting'
          ? { label: 'Sit', command: 'sit' }
          : null;

  return (
    <Stack spacing={0.75} sx={{ alignItems: 'flex-start', maxWidth: 200 }}>
      <Stack
        direction="row"
        spacing={0.75}
        sx={[glassSurfaceSx, { alignItems: 'center', borderRadius: 999, px: 1.25, py: 0.5 }]}
      >
        <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: PHASE_DOT[phase], flexShrink: 0 }} />
        <Typography sx={{ fontSize: TYPO.xs, fontWeight: FONT_WEIGHT.semibold, whiteSpace: 'nowrap' }}>
          {PHASE_LABEL[phase]}
          {connected && typeof tilt === 'number' ? ` · ${tilt.toFixed(1)}°` : ''}
          {connected && status?.link.kind ? ` · ${status.link.kind === 'usb' ? 'USB' : 'BT'}` : ''}
        </Typography>
      </Stack>
      <Stack direction="row" spacing={0.75}>
        {action && (
          <Button
            disabled={busy}
            onClick={() => base.run(action.command)}
            sx={glassButtonSx}
            startIcon={pending === action.command ? <CircularProgress size={12} color="inherit" /> : undefined}
          >
            {action.label}
          </Button>
        )}
        {connected && (
          <Button
            aria-label="Emergency stop the base"
            disabled={disabled}
            onClick={() => base.run('stop')}
            sx={{
              ...glassButtonSx,
              bgcolor: '#dc2626',
              borderColor: 'rgba(255,255,255,0.4)',
              '&:hover': { bgcolor: '#b91c1c' },
            }}
          >
            STOP
          </Button>
        )}
      </Stack>
      {error && (
        <Typography sx={[glassSurfaceSx, { fontSize: TYPO.tiny, borderRadius: 1.5, px: 1, py: 0.5 }]}>
          {error}
        </Typography>
      )}
    </Stack>
  );
}
