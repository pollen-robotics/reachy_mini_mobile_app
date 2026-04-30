/**
 * Permissions onboarding screen.
 *
 * Shown once between the auth gate and the discovery view, on the
 * very first launch (or after the user clears the local flag). The
 * goal is to surface every iOS permission prompt the app needs in a
 * single, predictable cascade gated by **one** "Continue" tap, so the
 * user is never surprised mid-conversation by a system dialog and -
 * critically - the WebRTC LAN-candidate unlock happens before the
 * first connection attempt, not in the middle of a stuck handshake.
 *
 * What we ask for
 * ───────────────
 *   1. Microphone - required for ICE on iOS WKWebView, see
 *      `iosMicUnlock.ts` for the WebKit privacy quirk that forces this.
 *      We never actually capture audio from the phone (the robot is
 *      the audio hub), but we need the grant to expose LAN candidates.
 *
 * Permissions we deliberately do **not** prompt for here
 * ──────────────────────────────────────────────────────
 *   - Bluetooth: prompted automatically by the OS the first time the
 *     BLE plugin scans, which happens on `ScanScreen` mount. The user
 *     gesture context is the screen transition itself.
 *   - Local Network: prompted automatically the first time we hit a
 *     LAN address (typically the local daemon on `127.0.0.1:8000`).
 *
 * If we tried to fire all three together we'd race the iOS dialog
 * presentation and end up with prompts queued behind each other in an
 * order the user can't reason about.
 *
 * Failure modes
 * ─────────────
 * The screen always advances on tap, regardless of whether the user
 * granted or denied the prompt: denying is a valid choice, the
 * conversation engine has a TURN fallback, and re-prompting on every
 * launch would be hostile. The user can flip permissions back on in
 * iOS Settings -> Reachy Mini if they change their mind.
 */
import { useCallback, useState } from 'react';
import { Box, Button, CircularProgress, Stack, Typography } from '@mui/material';
import MicNoneIcon from '@mui/icons-material/MicNone';

import HeroIllustration from '../components/HeroIllustration';
import astronautSvg from '../assets/astronaut.svg';
import { unlockIosMicForWebRtc } from '../permissions/iosMicUnlock';
import { FONT_WEIGHT, LAYOUT, RADIUS, TYPO } from '../styles/tokens';

interface PermissionsScreenProps {
  /** Called once the prompts have all been resolved (granted or denied). */
  onDone: () => void;
}

export default function PermissionsScreen({ onDone }: PermissionsScreenProps) {
  const [busy, setBusy] = useState(false);

  const handleContinue = useCallback(() => {
    if (busy) return;
    setBusy(true);
    // Fire-and-forget: we want the prompt cascade to start in the
    // synchronous user-gesture frame of the click handler. iOS will
    // queue subsequent prompts behind the current one. We don't await
    // here so the click stack doesn't unwind before getUserMedia gets
    // its chance.
    void unlockIosMicForWebRtc()
      .catch(() => {
        // User denied or hardware missing. Either way we still
        // advance: the conversation engine will fall back to TURN
        // (or re-prompt later via doConnect's own unlock call).
      })
      .finally(() => {
        onDone();
      });
  }, [busy, onDone]);

  return (
    <Stack
      sx={{
        height: '100%',
        width: '100%',
        bgcolor: 'background.default',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        px: 3,
      }}
    >
      <Stack
        spacing={2}
        sx={{
          alignItems: 'center',
          maxWidth: LAYOUT.contentMaxWidth,
          width: '100%',
        }}
      >
        <HeroIllustration
          src={astronautSvg}
          alt="Reachy Mini astronaut"
          animation="float"
          size={140}
          mb={1}
        />

        <Typography
          sx={{
            fontSize: TYPO.xl,
            fontWeight: FONT_WEIGHT.bold,
            color: 'text.primary',
            letterSpacing: '-0.2px',
          }}
        >
          One quick setup
        </Typography>

        <Typography
          sx={{
            fontSize: TYPO.sm,
            color: 'text.secondary',
            lineHeight: 1.6,
            maxWidth: 320,
          }}
        >
          Reachy Mini needs a few system permissions to connect to your
          robot reliably. We'll only ask once.
        </Typography>

        <Stack
          spacing={1.5}
          sx={{
            mt: 1,
            mb: 1,
            width: '100%',
            maxWidth: 320,
            textAlign: 'left',
          }}
        >
          <PermissionRow
            icon={<MicNoneIcon fontSize="small" />}
            title="Microphone"
            // Honest but light: explaining the LAN-candidate WebKit
            // quirk in full would be incomprehensible. The user's
            // mental model "the app needs the mic to do voice" is
            // close enough to the truth (the conversation does need
            // a working WebRTC connection) and earns trust.
            body="So WebRTC can find your robot on the local network."
          />
        </Stack>

        {!busy ? (
          <Button
            variant="outlined"
            color="primary"
            onClick={handleContinue}
            sx={{
              borderRadius: RADIUS.pill,
              textTransform: 'none',
              fontWeight: FONT_WEIGHT.semibold,
              px: 4,
              py: 1.25,
              borderWidth: 1.5,
              '&:hover': { borderWidth: 1.5 },
            }}
          >
            Continue
          </Button>
        ) : (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <CircularProgress size={18} />
            <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary' }}>
              Asking for permission...
            </Typography>
          </Box>
        )}
      </Stack>
    </Stack>
  );
}

function PermissionRow({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <Stack
      direction="row"
      spacing={1.5}
      sx={{
        p: 1.5,
        borderRadius: 2,
        bgcolor: 'background.paper',
        border: theme => `1px solid ${theme.palette.divider}`,
      }}
    >
      <Box
        sx={{
          width: 32,
          height: 32,
          flexShrink: 0,
          borderRadius: 1,
          bgcolor: 'action.hover',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'text.secondary',
        }}
      >
        {icon}
      </Box>
      <Stack sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          sx={{
            fontSize: TYPO.sm,
            fontWeight: FONT_WEIGHT.semibold,
            color: 'text.primary',
          }}
        >
          {title}
        </Typography>
        <Typography
          sx={{
            fontSize: TYPO.xs,
            color: 'text.secondary',
            lineHeight: 1.5,
          }}
        >
          {body}
        </Typography>
      </Stack>
    </Stack>
  );
}
