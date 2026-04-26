import { Chip, CircularProgress } from '@mui/material';

import type { DaemonProbeState } from '../daemon/useDaemonStatus';

interface StatusBadgeProps {
  probe: DaemonProbeState;
}

/**
 * Compact summary chip for the daemon health probe. Colors map to the
 * three outcomes the UI cares about:
 *   - probing → neutral with spinner
 *   - ok      → green, daemon state shown
 *   - error   → red, short message
 */
export default function StatusBadge({ probe }: StatusBadgeProps) {
  switch (probe.kind) {
    case 'idle':
      return <Chip label="Waiting" size="small" variant="outlined" />;
    case 'probing':
      return (
        <Chip
          label="Probing"
          size="small"
          variant="outlined"
          icon={<CircularProgress size={12} />}
        />
      );
    case 'ok': {
      const { state, version } = probe.status;
      const label = version ? `${state} · v${version}` : state;
      const color = state === 'running' ? 'success' : 'warning';
      return <Chip label={label} size="small" color={color} />;
    }
    case 'error':
      return <Chip label={probe.message} size="small" color="error" variant="outlined" />;
  }
}
