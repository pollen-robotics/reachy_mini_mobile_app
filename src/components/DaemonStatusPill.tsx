/**
 * Compact daemon status pill, shown in places where space is at a
 * premium and we just want a "is the daemon reachable?" signal at a
 * glance: typically the top of the conversation panel in remote mode,
 * where the user wants visual confirmation that the WebRTC tunnel is
 * up before they start talking.
 *
 * Three visual states map to three colours via MUI's palette so the
 * pill adapts to dark/light mode without hardcoded hex values:
 *
 *   - `idle` / `probing` → neutral grey, "Connecting…"
 *   - `ok`               → success green, "running · v1.2.3"
 *   - `error`            → warning amber, message inlined
 *
 * The component is intentionally read-only - it does not own the
 * polling cadence, that lives in the parent's `useDaemonStatus` hook.
 * Pass the probe state in and the pill renders it.
 */
import { Box, CircularProgress, Stack, Typography } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';

import type { DaemonProbeState } from '../daemon/useDaemonStatus';

interface DaemonStatusPillProps {
  probe: DaemonProbeState;
}

export default function DaemonStatusPill({
  probe,
}: DaemonStatusPillProps) {
  let icon: React.ReactNode;
  let label: string;
  let palette: 'neutral' | 'ok' | 'warn';

  switch (probe.kind) {
    case 'idle':
    case 'probing':
      icon = <CircularProgress size={12} thickness={5} />;
      label = 'Connecting…';
      palette = 'neutral';
      break;
    case 'ok': {
      const v = probe.status.version ? ` · v${probe.status.version}` : '';
      icon = <CheckCircleIcon sx={{ fontSize: 14 }} />;
      label = `daemon ${probe.status.state}${v}`;
      palette = 'ok';
      break;
    }
    case 'error':
      icon = <ErrorOutlineIcon sx={{ fontSize: 14 }} />;
      label = probe.message;
      palette = 'warn';
      break;
  }

  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={0.75}
      sx={{
        px: 1,
        py: 0.25,
        borderRadius: 99,
        bgcolor: theme =>
          palette === 'ok'
            ? theme.palette.success.main + '22'
            : palette === 'warn'
              ? theme.palette.warning.main + '22'
              : theme.palette.action.hover,
        color: theme =>
          palette === 'ok'
            ? theme.palette.success.main
            : palette === 'warn'
              ? theme.palette.warning.main
              : theme.palette.text.secondary,
        border: theme =>
          `1px solid ${
            palette === 'ok'
              ? theme.palette.success.main + '55'
              : palette === 'warn'
                ? theme.palette.warning.main + '55'
                : theme.palette.divider
          }`,
        maxWidth: '100%',
        minWidth: 0,
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 14,
          height: 14,
          flexShrink: 0,
        }}
      >
        {icon}
      </Box>
      <Typography
        variant="caption"
        sx={{
          fontFamily: 'monospace',
          fontSize: 11,
          fontWeight: 500,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </Typography>
    </Stack>
  );
}
