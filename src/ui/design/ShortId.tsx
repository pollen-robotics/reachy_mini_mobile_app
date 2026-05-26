/**
 * Five-character monospace tag for a robot's stable identity.
 *
 * Renders the first 5 chars of the daemon-reported `hardware_id`
 * (sourced from `meta.hardware_id` on central listings). A user can
 * use this to recognise a specific robot across sessions even when
 * other ids (peer id) rotate.
 *
 * Falls back to the first 5 chars of `fallbackId` (typically the
 * `peerId` for central listings) when `hardware_id` is unavailable
 * - daemons older than PR-1084 don't advertise it. Renders nothing
 * when neither id is present.
 *
 * 5 chars on a SHA-256 prefix = 20 bits of entropy, more than
 * enough to disambiguate the robots in a personal fleet without
 * making the tag visually heavy.
 *
 * The `as` prop chooses between two visual treatments:
 *   - `text` (default): a small monospace caption inline next to
 *     the robot name, used in the discovery cards.
 *   - `chip`: an outlined MUI Chip, used in the post-connect
 *     identity bar where the surrounding chips dominate the row.
 */
import { Chip, Typography } from '@mui/material';

import { TYPO } from './tokens';

const PREFIX_LENGTH = 5;

export interface ShortIdProps {
  hardwareId: string | null;
  fallbackId?: string | null;
  as?: 'text' | 'chip';
}

export function ShortId({
  hardwareId,
  fallbackId,
  as = 'text',
}: ShortIdProps) {
  const id = hardwareId ?? fallbackId ?? null;
  if (!id) return null;

  const label = `id:${id.slice(0, PREFIX_LENGTH)}`;

  if (as === 'chip') {
    return (
      <Chip
        label={label}
        size="small"
        variant="outlined"
        sx={{
          height: 22,
          fontSize: TYPO.tiny,
          fontFamily: 'monospace',
        }}
      />
    );
  }

  return (
    <Typography
      variant="caption"
      sx={{
        fontFamily: 'monospace',
        color: 'text.secondary',
        fontSize: 11,
        flexShrink: 0,
      }}
    >
      {label}
    </Typography>
  );
}
