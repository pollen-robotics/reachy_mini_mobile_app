/**
 * Identity block rendered on the left side of the session top bar.
 *
 * Two-line layout, both rows left-aligned right after the avatar:
 *
 *   ┌──┐  reachy_mini  [Wi-Fi]      ← row 1 : name (hero) + transport chip
 *   │🤖│  #abc12                    ← row 2 : short hardware id
 *   └──┘
 *
 * The split is intentional:
 *   - row 1 carries the **mutable / configurable** identity bits:
 *     the user-chosen `robotName` (changeable via the daemon) and
 *     the physical transport pill (Wi-Fi / USB / ...), which is
 *     "how am I reaching the robot right now" at a glance and is
 *     useful even outside a debug context (a quick eye-check that
 *     I'm not on the wrong link).
 *   - row 2 carries the **fixed fingerprint**: the short hardware
 *     id (immutable per machine), rendered in monospace so it
 *     reads as an identifier rather than a label.
 *
 * Reading top→bottom within the column: meaningful → technical.
 *
 * Earlier revisions also surfaced the daemon version here, and a
 * live WebRTC transport badge (LAN / Direct / Relay + IP +
 * bitrate). Those signals are debug-grade only and now live in the
 * on-demand `<RobotInfoSheet>` opened from the `ⓘ` button in the
 * topbar's right action cluster. The transport chip stays here
 * because a quick "USB or Wi-Fi" read is everyday-grade
 * information, not debug-grade.
 *
 * The little Reachy avatar on the left is the same illustration
 * used on the discovery cards (just smaller), so the user
 * recognises "their" robot at a glance.
 *
 * Pure presentational: the host (`RobotSessionScreen`) owns the
 * power-off button and any other actions; this component only
 * renders identity.
 */
import { Box, Stack, Typography } from '@mui/material';

import RobotAvatar from '@/ui/design/RobotAvatar';
import { TransportChip } from '@/ui/design/TransportChip';
import { FONT_WEIGHT, TYPO } from '@/ui/design/tokens';

interface IdentityChipBarProps {
  robotName: string;
  hardwareId: string | null;
  /** Falls back to the peerId when the daemon hasn't shipped PR-1084 yet. */
  fallbackId?: string | null;
  /** Physical transport string from the robot's central listing
   *  (`wifi` / `usb` / …). Rendered via `<TransportChip>` to the
   *  right of the robot name. */
  transport: string;
}

const SHORT_ID_LENGTH = 5;
/**
 * Avatar diameter inside the topbar. Sized to feel substantial
 * next to the two-line identity column without crowding the row.
 * The antennas overflow upwards from the disc by design (cf.
 * `RobotAvatar`); the topbar bg is `background.paper` and the
 * antennas SVG is dark, so the silhouette reads cleanly against
 * either palette.
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
}: IdentityChipBarProps) {
  const idTag = (hardwareId ?? fallbackId ?? '').slice(0, SHORT_ID_LENGTH);
  // Em-dash placeholder so the row 2 layout stays stable if both
  // hardwareId and fallbackId are missing (shouldn't happen in
  // practice but the host's defensive early-return only handles
  // the missing-peerId case, not a fully empty identity).
  const idLabel = idTag ? `#${idTag}` : '—';

  return (
    <Stack
      direction="row"
      spacing={1.25}
      sx={{
        alignItems: 'center',
        minWidth: 0,
        flex: 1,
      }}
    >
      <Box sx={{ mt: `${TOPBAR_AVATAR_VERTICAL_NUDGE_PX}px`, flexShrink: 0 }}>
        <RobotAvatar size={TOPBAR_AVATAR_SIZE} />
      </Box>
      {/* Two-row column hugging the avatar. Row 1: name + transport
          chip side by side, with the name allowed to ellipsis if
          the screen is too narrow so the chip stays visible. Row 2:
          the short hardware id alone. The host's own toolbar owns
          the right edge for the power-off button. */}
      <Stack spacing={0.25} sx={{ minWidth: 0, flex: 1 }}>
        <Stack
          direction="row"
          spacing={1}
          sx={{
            alignItems: 'center',
            minWidth: 0,
          }}
        >
          <Typography
            sx={{
              minWidth: 0,
              fontSize: TYPO.md,
              fontWeight: FONT_WEIGHT.bold,
              color: 'text.primary',
              letterSpacing: '-0.1px',
              lineHeight: 1.2,
              // `flexShrink` lets the name truncate via ellipsis
              // when the available column is too narrow, while
              // the transport chip stays visible at its natural
              // width to its right.
              flexShrink: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            noWrap
          >
            {robotName}
          </Typography>
          <Box sx={{ flexShrink: 0 }}>
            <TransportChip transport={transport} height={20} />
          </Box>
        </Stack>

        <Typography
          component="span"
          title="Hardware id"
          sx={{
            fontSize: TYPO.xs,
            fontFamily: 'monospace',
            color: theme =>
              theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.40)' : 'rgba(0,0,0,0.36)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {idLabel}
        </Typography>
      </Stack>
    </Stack>
  );
}
