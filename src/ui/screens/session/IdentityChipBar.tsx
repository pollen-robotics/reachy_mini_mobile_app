/**
 * Identity block rendered on the left side of the session top bar.
 *
 * Two-line layout, both rows left-aligned right after the avatar:
 *
 *   ┌──┐  reachy_mini  [Wi-Fi]     ← row 1 : name (hero) + transport chip
 *   │🤖│  v1.7.1  #abc12           ← row 2 : daemon version + short hardware id
 *   └──┘
 *
 * The split is intentional:
 *   - row 1 carries the **mutable / configurable** identity bits:
 *     the user-chosen `robotName` (changeable via the daemon) and
 *     the live transport (Wi-Fi / USB / ...) which can flip
 *     mid-session.
 *   - row 2 carries the **fixed fingerprint**: the daemon version
 *     (only changes on a software update) and the hardware id
 *     (immutable per machine). Both rendered in monospace so they
 *     read as identifiers, not as labels.
 *
 * Reading left→right within a row: identity-name + identity-spec.
 * Reading top→bottom within a column: meaningful → technical.
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

import { useDaemonState } from '@/features/daemon-state';
import { TransportChip } from '@/ui/design/TransportChip';
import RobotAvatar from '@/ui/design/RobotAvatar';
import { FONT_WEIGHT, TYPO } from '@/ui/design/tokens';

interface IdentityChipBarProps {
  robotName: string;
  hardwareId: string | null;
  /** Falls back to the peerId when the daemon hasn't shipped PR-1084 yet. */
  fallbackId?: string | null;
  transport: string;
  /**
   * Daemon version is read from the shared `<DaemonStateProvider>`
   * via `useDaemonState()`. It is intentionally NOT passed as a
   * prop: that would either force the host to fetch it (creating
   * a parallel source of truth) or to thread the context through
   * an extra prop drill - both worse than letting the chip read
   * the context directly. The host (`RobotSessionScreen`) owns
   * mounting the provider; this component only consumes it.
   */
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
}: IdentityChipBarProps) {
  const idTag = (hardwareId ?? fallbackId ?? '').slice(0, SHORT_ID_LENGTH);
  const { daemonVersion } = useDaemonState();

  // Em-dash placeholders so the row 2 layout stays stable while
  // the daemon-state context is still doing its first round-trip
  // (the values land within ~250 ms thanks to the retry-on-null,
  // so the placeholder window is short but non-zero).
  const versionLabel = daemonVersion ? `v${daemonVersion}` : '—';
  const idLabel = idTag ? `#${idTag}` : '—';

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

      {/* Two-row grid, both rows left-aligned hugging the avatar:
          row items sit side-by-side with a small gap. The right
          edge of the column is left empty on purpose - the
          identity is dense and reads as one unit, not as a
          space-between layout that would float the chip / id far
          from the name they describe. The host's own toolbar
          owns the right edge for the power-off button. */}
      <Stack spacing={0.25} sx={{ minWidth: 0, flex: 1 }}>
        <Stack
          direction="row"
          alignItems="center"
          spacing={1}
          sx={{ minWidth: 0 }}
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

        <Stack
          direction="row"
          alignItems="center"
          spacing={0.875}
          sx={{ minWidth: 0 }}
        >
          <Typography
            component="span"
            title="Daemon version"
            sx={{
              fontSize: TYPO.xs,
              fontFamily: 'monospace',
              color: (theme) =>
                theme.palette.mode === 'dark'
                  ? 'rgba(255,255,255,0.45)'
                  : 'rgba(0,0,0,0.42)',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {versionLabel}
          </Typography>
          {/* Tiny vertical divider between the two technical
              fields. The visual references the divider you see in
              browser dev tools, IDE status bars, `chrome://version`
              etc. - a status-line affordance the eye reads as
              "these two values belong on the same line but are
              independent". 1×10 px keeps it discreet; opacity
              tuned a bit lower than the surrounding text so the
              monospace values stay the dominant ink. */}
          <Box
            aria-hidden
            sx={(theme) => ({
              flexShrink: 0,
              width: '1px',
              height: '10px',
              bgcolor:
                theme.palette.mode === 'dark'
                  ? 'rgba(255,255,255,0.22)'
                  : 'rgba(0,0,0,0.18)',
            })}
          />
          <Typography
            component="span"
            title="Hardware id"
            sx={{
              fontSize: TYPO.xs,
              fontFamily: 'monospace',
              color: (theme) =>
                theme.palette.mode === 'dark'
                  ? 'rgba(255,255,255,0.40)'
                  : 'rgba(0,0,0,0.36)',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {idLabel}
          </Typography>
        </Stack>
      </Stack>
    </Stack>
  );
}
