/**
 * First-Reachy onboarding invite.
 *
 * Shown on `ScanScreen` when the user is signed in but has no Reachy linked to
 * their account yet. Deliberately styled as the first page of the BLE setup
 * wizard (mirrors `SetupWizardScreen`'s `Headline` + `PrimaryButton`): a
 * centered title + caption over a single outlined, full-width CTA - no
 * card/drop-zone container and no fleet-list chrome (hero illustration /
 * "Your Reachies" header are hidden by the parent), so this reads as a
 * dedicated onboarding screen rather than an empty list.
 *
 * The setup CTA is Bluetooth Wi-Fi provisioning, which only applies to the
 * Wireless version. A Lite is never provisioned: it shows up here once
 * Reachy Mini Control runs its daemon on the host computer, so the Lite
 * hint under the CTA keeps Lite owners out of a wizard that can't work
 * for them.
 */

import { Box, Button, Stack, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';

import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';

export default function FirstReachyInvite({ onStartSetup }: { onStartSetup: () => void }) {
  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <Stack spacing={0.75} sx={{ alignItems: 'center', textAlign: 'center' }}>
        <Typography sx={{ fontSize: TYPO.xxl, fontWeight: FONT_WEIGHT.semibold }}>
          Meet Your First Reachy Mini
        </Typography>
        <Typography
          sx={{ fontSize: TYPO.md, color: 'text.secondary', maxWidth: 320, lineHeight: 1.5 }}
        >
          Follow these simple steps to connect me and get everything ready.
        </Typography>
      </Stack>
      <Box sx={{ width: '100%', maxWidth: 320 }}>
        <Button
          variant="outlined"
          color="primary"
          fullWidth
          onClick={onStartSetup}
          startIcon={<AddIcon sx={{ fontSize: 22 }} />}
          sx={{
            textTransform: 'none',
            fontSize: TYPO.md,
            fontWeight: FONT_WEIGHT.semibold,
            borderRadius: `${RADIUS.md}px`,
            py: 1.25,
          }}
        >
          Set up a new Reachy
        </Button>
      </Box>
      <Typography
        sx={{
          fontSize: TYPO.sm,
          color: 'text.secondary',
          textAlign: 'center',
          maxWidth: 320,
          lineHeight: 1.5,
        }}
      >
        Have a Reachy Mini Lite? No setup needed: open Reachy Mini Control on the computer
        it&apos;s plugged into, signed in with this Hugging Face account, and it will show up here.
      </Typography>
    </Stack>
  );
}
