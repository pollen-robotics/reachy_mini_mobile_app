/**
 * Identity block rendered on the left side of the session top bar.
 *
 * Mirrors the visual taxonomy of the discovery cards on
 * `ScanScreen` so the user keeps a stable "this is the robot
 * I'm in" anchor across the navigation:
 *
 *   ┌──┐  reachy_mini  #abc12     ← name (bold) + short hardware id
 *   │🤖│  [Wi-Fi]                  ← transport chip
 *   └──┘
 *
 * The little Reachy avatar on the left is the same illustration
 * used on the discovery cards (just smaller), so the user
 * recognises "their" robot at a glance.
 *
 * The HF user chip used to live here too but it's been removed:
 * the user is, by definition, signed in (the gate runs upstream)
 * and the redundant `@username` was just adding noise to the bar.
 *
 * Pure presentational: the host (`RobotSessionScreen`) owns the
 * power-off button and any other actions; this component only
 * renders identity.
 */
import { Box, Stack, Typography } from '@mui/material';

import { TransportChip } from '@/ui/design/TransportChip';
import RobotAvatar from '@/ui/design/RobotAvatar';
import { FONT_WEIGHT, TYPO } from '@/ui/design/tokens';

interface IdentityChipBarProps {
  robotName: string;
  hardwareId: string | null;
  /** Falls back to the peerId when the daemon hasn't shipped PR-1084 yet. */
  fallbackId?: string | null;
  transport: string;
  /** Daemon version reported by `robot.getVersion()`, fetched once per
   *  session. Null when the data channel isn't open yet or when the
   *  daemon predates the `get_version` Cmd. */
  daemonVersion?: string | null;
}

const SHORT_ID_LENGTH = 5;
/**
 * Avatar diameter inside the topbar. Sized to feel substantial
 * next to the two-line identity column (bold name + transport
 * chip) without crowding the row. The antennas overflow upwards
 * from the disc by design (cf. `RobotAvatar`); the topbar bg is
 * `background.paper` and the antennas SVG is dark, so the
 * silhouette reads cleanly against either palette.
 */
const TOPBAR_AVATAR_SIZE = 44;
/**
 * Small downward nudge that shifts the avatar disc to compensate
 * for the antennas overflowing the rim by ~6 px upwards. Without
 * this, `alignItems: 'center'` on the row centres the *disc*, not
 * the *visual silhouette* (disc + antenna overflow), so the whole
 * avatar reads as too high. Pushing it 4 px down re-centres the
 * silhouette around the row's true vertical midpoint.
 */
const TOPBAR_AVATAR_VERTICAL_NUDGE_PX = 4;

export default function IdentityChipBar({
  robotName,
  hardwareId,
  fallbackId,
  transport,
  daemonVersion,
}: IdentityChipBarProps) {
  const idTag = (hardwareId ?? fallbackId ?? '').slice(0, SHORT_ID_LENGTH);

  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1.25}
      sx={{ minWidth: 0, flex: 1 }}
    >
      <Box sx={{ mt: `${TOPBAR_AVATAR_VERTICAL_NUDGE_PX}px`, flexShrink: 0 }}>
        <RobotAvatar size={TOPBAR_AVATAR_SIZE} />
      </Box>
      <Stack spacing={0.5} sx={{ minWidth: 0, flex: 1 }}>
        <Typography
          sx={{
            fontSize: TYPO.md,
            fontWeight: FONT_WEIGHT.bold,
            color: 'text.primary',
            letterSpacing: '-0.1px',
            lineHeight: 1.2,
            minWidth: 0,
          }}
          noWrap
        >
          {robotName}
          {idTag ? (
            <Box
              component="span"
              sx={{
                ml: 1,
                fontFamily: 'monospace',
                fontWeight: FONT_WEIGHT.regular,
                color: theme =>
                  theme.palette.mode === 'dark'
                    ? 'rgba(255,255,255,0.40)'
                    : 'rgba(0,0,0,0.36)',
                letterSpacing: 0,
              }}
            >
              {`#${idTag}`}
            </Box>
          ) : null}
        </Typography>
        <Stack
          direction="row"
          alignItems="center"
          spacing={0.75}
          sx={{ minWidth: 0 }}
        >
          <TransportChip transport={transport} height={20} />
          {daemonVersion ? (
            <Typography
              component="span"
              sx={{
                fontSize: TYPO.xs,
                fontFamily: 'monospace',
                color: theme =>
                  theme.palette.mode === 'dark'
                    ? 'rgba(255,255,255,0.45)'
                    : 'rgba(0,0,0,0.42)',
                whiteSpace: 'nowrap',
              }}
              title="Daemon version"
            >
              {`v${daemonVersion}`}
            </Typography>
          ) : null}
        </Stack>
      </Stack>
    </Stack>
  );
}
