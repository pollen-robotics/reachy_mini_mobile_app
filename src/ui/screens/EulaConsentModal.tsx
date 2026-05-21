/**
 * First-launch consent modal.
 *
 * Apple guideline 5.1.1 (privacy / data collection) + Google
 * Play's UGC policy expect users to be told, before any data is
 * collected or any UGC surface is rendered, what the app does
 * with their data and what kinds of third-party content they may
 * encounter.
 *
 * Lifecycle
 * ─────────
 * Mounted from the App root after the splash and before any
 * other screen. Blocking: cannot be dismissed without tapping
 * "Accept and continue", which calls `onAccept` (wired to
 * `useTosConsent().accept()` upstream). Subsequent launches read
 * the persisted version and skip this modal entirely (see
 * `features/consent/useTosConsent.ts` for the version policy).
 *
 * What it discloses
 * ─────────────────
 * Four short bullets, each anchored to a real feature of the app
 * so the modal reads as "what to expect" rather than legalese:
 *
 *   1. Voice conversations    -> mic + OpenAI Realtime
 *   2. Third-party apps       -> HF Spaces in WebView + report flow
 *   3. Bluetooth + Wi-Fi      -> first-time robot bring-up
 *   4. Hugging Face sign-in   -> token storage on device
 *
 * The full Privacy Policy + Terms of Service URLs are linked
 * below the bullets so a user who wants the legal text can read
 * it before accepting. The strings come from the same constants
 * as the `HelpAndSupportSheet` (TODO placeholders today, replaced
 * post-legal review).
 *
 * Visual contract
 * ───────────────
 * Full-screen overlay, mirroring the `SplashScreen` /
 * `WelcomeBackScreen` pattern (`position: fixed; inset: 0`)
 * rather than MUI's `Dialog` because the rest of the app already
 * does fullscreen-from-the-root via that pattern. The body
 * scrolls if a small device truncates the bullets; the action
 * bar at the bottom is sticky so the primary CTA never moves.
 */
import { useCallback } from 'react';
import { Box, Button, Stack, Typography } from '@mui/material';
import AppsOutlinedIcon from '@mui/icons-material/AppsOutlined';
import BluetoothIcon from '@mui/icons-material/Bluetooth';
import GraphicEqOutlinedIcon from '@mui/icons-material/GraphicEqOutlined';
import VerifiedUserOutlinedIcon from '@mui/icons-material/VerifiedUserOutlined';

import hfLogoUrl from '@/assets/hf-logo.svg';
import { openExternalUrl } from '@/shared/tauri/openUrl';
import { FONT_WEIGHT, LAYOUT, RADIUS, TYPO } from '@/ui/design/tokens';

/**
 * Same TODO placeholders as `HelpAndSupportSheet`. We duplicate
 * (rather than import) so the strings stay co-located with the
 * surface that uses them, and so the consent modal still tells
 * a coherent story if Help & Support is later moved or reworked.
 * When legal lands the canonical URLs, update both files in one
 * pass.
 */
const PRIVACY_POLICY_URL = 'https://pollen-robotics.com/privacy';
const TERMS_OF_SERVICE_URL = 'https://pollen-robotics.com/terms';

interface EulaConsentModalProps {
  onAccept: () => void;
}

interface DisclosureBullet {
  icon: typeof GraphicEqOutlinedIcon;
  title: string;
  body: string;
}

const BULLETS: readonly DisclosureBullet[] = [
  {
    icon: GraphicEqOutlinedIcon,
    title: 'Voice conversations',
    body:
      'When you start a conversation, your microphone audio is sent to OpenAI Realtime to power Reachy Mini\u2019s replies. Audio is not stored on our servers.',
  },
  {
    icon: AppsOutlinedIcon,
    title: 'Third-party apps',
    body:
      'The Apps tab lists experiences published by third parties on Hugging Face. They run in a sandboxed WebView. You can report or hide any app from the per-app menu.',
  },
  {
    icon: BluetoothIcon,
    title: 'Bluetooth and Wi-Fi',
    body:
      'Bluetooth and local network access are used only to discover your Reachy Mini and bring it onto Wi-Fi the first time. No data leaves the device for these flows.',
  },
  {
    icon: VerifiedUserOutlinedIcon,
    title: 'Hugging Face sign-in',
    body:
      'You sign in with Hugging Face. Your access token is stored on this device and used to talk to the central signaling Space and to load apps from the Hub.',
  },
];

export default function EulaConsentModal({ onAccept }: EulaConsentModalProps) {
  const handleOpenPrivacy = useCallback(async () => {
    try {
      await openExternalUrl(PRIVACY_POLICY_URL);
    } catch (err) {
      console.warn('[consent] privacy URL failed:', err);
    }
  }, []);

  const handleOpenTerms = useCallback(async () => {
    try {
      await openExternalUrl(TERMS_OF_SERVICE_URL);
    } catch (err) {
      console.warn('[consent] terms URL failed:', err);
    }
  }, []);

  return (
    <Box
      role="dialog"
      aria-modal="true"
      aria-labelledby="eula-title"
      aria-describedby="eula-summary"
      sx={{
        position: 'fixed',
        inset: 0,
        zIndex: 1400,
        bgcolor: 'background.default',
        color: 'text.primary',
        display: 'flex',
        flexDirection: 'column',
        // Full safe-area handling. The header ducks under the
        // notch via `safeAreaTop`, the action bar sits above the
        // home indicator via `safeAreaBottom`. Same pattern as
        // the rest of the screens.
        pt: `calc(${LAYOUT.safeAreaTop} + 16px)`,
        pb: `calc(${LAYOUT.safeAreaBottom} + 12px)`,
      }}
    >
      {/* Scrollable body. The action bar at the bottom is
          OUTSIDE this stack so it stays pinned regardless of how
          tall the bullet list grows on smaller phones (e.g.
          dynamic type / accessibility text). */}
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          px: 3,
        }}
      >
        <Stack alignItems="center" spacing={1.25} sx={{ pt: 1, pb: 3 }}>
          <Box
            component="img"
            src={hfLogoUrl}
            alt=""
            aria-hidden
            sx={{ width: 56, height: 56, mb: 0.5 }}
          />
          <Typography
            id="eula-title"
            component="h1"
            sx={{
              fontSize: TYPO.hero,
              fontWeight: FONT_WEIGHT.bold,
              letterSpacing: '-0.3px',
              textAlign: 'center',
              m: 0,
            }}
          >
            Before we begin
          </Typography>
          <Typography
            id="eula-summary"
            sx={{
              fontSize: TYPO.md,
              color: 'text.secondary',
              textAlign: 'center',
              maxWidth: 360,
            }}
          >
            Here&apos;s what Reachy Mini Mobile does, and what we ask of
            your device. Tap accept to continue.
          </Typography>
        </Stack>

        <Stack spacing={2} sx={{ maxWidth: LAYOUT.contentMaxWidth, mx: 'auto' }}>
          {BULLETS.map(({ icon: Icon, title, body }) => (
            <Stack
              key={title}
              direction="row"
              spacing={1.75}
              alignItems="flex-start"
              sx={{
                p: 1.75,
                borderRadius: `${RADIUS.lg}px`,
                bgcolor: 'background.paper',
                border: theme => `1px solid ${theme.palette.divider}`,
              }}
            >
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  width: 36,
                  height: 36,
                  borderRadius: '50%',
                  color: 'primary.main',
                  bgcolor: theme =>
                    theme.palette.mode === 'dark'
                      ? 'rgba(255,255,255,0.06)'
                      : 'rgba(0,0,0,0.04)',
                }}
              >
                <Icon fontSize="small" />
              </Box>
              <Stack spacing={0.5} sx={{ minWidth: 0 }}>
                <Typography
                  sx={{
                    fontSize: TYPO.body,
                    fontWeight: FONT_WEIGHT.semibold,
                    color: 'text.primary',
                    lineHeight: 1.25,
                  }}
                >
                  {title}
                </Typography>
                <Typography
                  sx={{
                    fontSize: TYPO.sm,
                    color: 'text.secondary',
                    lineHeight: 1.5,
                  }}
                >
                  {body}
                </Typography>
              </Stack>
            </Stack>
          ))}
        </Stack>

        <Stack
          direction="row"
          spacing={2}
          justifyContent="center"
          sx={{ pt: 3, pb: 1, flexWrap: 'wrap' }}
        >
          <Button
            variant="text"
            size="small"
            onClick={handleOpenPrivacy}
            sx={{
              fontSize: TYPO.xs,
              textTransform: 'none',
              color: 'text.secondary',
            }}
          >
            Privacy Policy
          </Button>
          <Button
            variant="text"
            size="small"
            onClick={handleOpenTerms}
            sx={{
              fontSize: TYPO.xs,
              textTransform: 'none',
              color: 'text.secondary',
            }}
          >
            Terms of Service
          </Button>
        </Stack>
      </Box>

      {/* Sticky action bar. `pt` paints a soft top divider via the
          theme's `divider` token so the bar reads as a separate
          plate from the scrolling body. The button is the single
          visible CTA so there's no ambiguity about how to leave
          this modal. */}
      <Box
        sx={{
          px: 3,
          pt: 1.5,
          borderTop: theme => `1px solid ${theme.palette.divider}`,
          bgcolor: 'background.default',
        }}
      >
        <Button
          fullWidth
          variant="contained"
          size="large"
          onClick={onAccept}
          sx={{
            textTransform: 'none',
            fontSize: TYPO.md,
            fontWeight: FONT_WEIGHT.semibold,
            py: 1.25,
            borderRadius: `${RADIUS.md}px`,
          }}
        >
          Accept and continue
        </Button>
      </Box>
    </Box>
  );
}
