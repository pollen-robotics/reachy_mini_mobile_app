/**
 * Help for a robot on the account that central does not list right now.
 *
 * Opened from an offline row of the robot list. Says what usually keeps a
 * robot off the list and offers the fix the phone can do itself: joining a
 * Wi-Fi over Bluetooth for a Wireless, which is what a robot moved to a new
 * place needs. Nothing here signs the user in again or re-links the robot.
 *
 * It is also where an offline robot is removed from the list: tapping the
 * row is what a user does with a robot that won't connect, so the action is
 * found there without a delete button on every row or an edit mode for a
 * rare task. A forgotten robot still on the account comes back the next time
 * it's online, so no confirmation (the long-press shortcut on the row asks
 * one, since a press can be accidental).
 */
import { useRef } from 'react';
import { Box, Button, Drawer, Stack, Typography } from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineRounded';
import WifiRoundedIcon from '@mui/icons-material/WifiRounded';

import type { KnownRobot } from '@/features/auth/knownRobots';
import { useAndroidBack } from '@/shared/tauri/useAndroidBack';
import { FONT_WEIGHT, LAYOUT, RADIUS, TYPO } from '@/ui/design/tokens';

export interface OfflineRobotSheetProps {
  /** The robot to help with; `null` closes the sheet. */
  robot: KnownRobot | null;
  onClose: () => void;
  /** Open the Bluetooth Wi-Fi setup. */
  onConnectWifi: () => void;
  onForget: (robot: KnownRobot) => void;
}

export default function OfflineRobotSheet({
  robot,
  onClose,
  onConnectWifi,
  onForget,
}: OfflineRobotSheetProps) {
  useAndroidBack(robot !== null, onClose);
  // Keep the last robot on screen while the sheet slides out.
  const shownRef = useRef<KnownRobot | null>(null);
  if (robot) shownRef.current = robot;
  const shown = shownRef.current;
  // A Lite has no Wi-Fi of its own: it is online while its computer runs it.
  const lite = shown?.transport === 'usb';
  const tips = lite
    ? [
        'Plug Reachy into your computer and open Reachy Mini Control.',
        'Keep the computer awake and online while you use Reachy.',
      ]
    : [
        'Make sure Reachy is switched on. It takes about a minute to come online.',
        'Moved Reachy somewhere new? It has to join the Wi-Fi there first.',
        'Still missing? Turn Reachy off and on again.',
      ];

  return (
    <Drawer
      anchor="bottom"
      open={robot !== null}
      onClose={onClose}
      slotProps={{
        paper: {
          sx: {
            borderTopLeftRadius: RADIUS.xl,
            borderTopRightRadius: RADIUS.xl,
            pb: `calc(${LAYOUT.safeAreaBottom} + 16px)`,
          },
        },
      }}
    >
      <Stack spacing={2} sx={{ px: 3, pt: 3, maxWidth: LAYOUT.contentMaxWidth, mx: 'auto', width: '100%' }}>
        <Box>
          <Typography sx={{ fontSize: TYPO.lg, fontWeight: FONT_WEIGHT.semibold }}>
            {shown?.name} is offline
          </Typography>
          <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary', mt: 0.5 }}>
            It's still linked to your account. It shows up here again as soon as it's back
            online.
          </Typography>
        </Box>
        <Stack component="ul" spacing={1} sx={{ m: 0, pl: 2.5 }}>
          {tips.map(tip => (
            <Typography component="li" key={tip} sx={{ fontSize: TYPO.body }}>
              {tip}
            </Typography>
          ))}
        </Stack>
        {!lite && (
          <Button
            variant="contained"
            disableElevation
            startIcon={<WifiRoundedIcon />}
            onClick={onConnectWifi}
            sx={{ textTransform: 'none', fontWeight: FONT_WEIGHT.semibold, borderRadius: 999 }}
          >
            Connect Reachy to Wi-Fi
          </Button>
        )}
        <Button
          color="error"
          startIcon={<DeleteOutlineIcon />}
          onClick={() => robot && onForget(robot)}
          sx={{ textTransform: 'none', fontWeight: FONT_WEIGHT.semibold, borderRadius: 999 }}
        >
          Remove from this list
        </Button>
      </Stack>
    </Drawer>
  );
}
