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
 * Three short bullets, each anchored to a real feature of the app
 * so the modal reads as "what to expect" rather than legalese:
 *
 *   1. Voice conversations    -> mic + Hugging Face realtime
 *   2. Third-party apps       -> HF Spaces in WebView + report flow
 *   3. Hugging Face sign-in   -> token storage on device
 *
 * The Privacy Policy + Terms of Service URLs sit directly under
 * the primary CTA so the user who wants the legal text can read
 * it before accepting, but they no longer compete with the
 * disclosure flow for attention.
 *
 * Visual contract
 * ───────────────
 * Full-screen overlay, mirroring the `SplashScreen` /
 * `WelcomeBackScreen` pattern (`position: fixed; inset: 0`)
 * rather than MUI's `Dialog` because the rest of the app already
 * does fullscreen-from-the-root via that pattern.
 *
 * Layout: a centred title block, a single divider-list card that
 * holds the four disclosures (iOS Settings pattern, much more
 * compact than the previous four-cards-stacked layout - the
 * full set fits without scrolling on an iPhone 14-class viewport
 * in dynamic-type-default), and a sticky action plate that owns
 * both the primary CTA and the legal links.
 */
import { useCallback } from 'react';
import { Box, Button, Divider, Stack, Typography } from '@mui/material';
import AppsOutlinedIcon from '@mui/icons-material/AppsOutlined';
import GraphicEqOutlinedIcon from '@mui/icons-material/GraphicEqOutlined';
import VerifiedUserOutlinedIcon from '@mui/icons-material/VerifiedUserOutlined';

import reachyHeroUrl from '@/assets/locked-reachy.svg';
import { openExternalUrl } from '@/shared/tauri/openUrl';
import { FONT_WEIGHT, LAYOUT, RADIUS, TYPO } from '@/ui/design/tokens';

/**
 * Same canonical URLs as `HelpAndSupportSheet`. We duplicate
 * (rather than import) so the strings stay co-located with the
 * surface that uses them, and so the consent modal still tells
 * a coherent story if Help & Support is later moved or reworked.
 * Update both files in one pass on the next legal revision.
 */
const PRIVACY_POLICY_URL = 'https://www.pollen-robotics.com/personal-data-protection-charter/';
const TERMS_OF_SERVICE_URL =
  'https://www.pollen-robotics.com/general-terms-and-conditions-of-sales/';

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
    body: 'Your microphone audio is streamed to Hugging Face\u2019s realtime service to power Reachy Mini\u2019s replies. Audio is not stored on our servers.',
  },
  {
    icon: AppsOutlinedIcon,
    title: 'Third-party apps',
    body: 'The Apps tab lists experiences from third parties on Hugging Face. They run in a sandboxed WebView, and you can report or hide any of them.',
  },
  {
    icon: VerifiedUserOutlinedIcon,
    title: 'Hugging Face sign-in',
    body: 'You sign in with Hugging Face. Your access token is stored on this device and used to load apps from the Hub.',
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
        pt: `calc(${LAYOUT.safeAreaTop} + 24px)`,
        pb: `calc(${LAYOUT.safeAreaBottom} + 12px)`,
      }}
    >
      {/* Scrollable body. The action plate is OUTSIDE this stack
          so it stays pinned regardless of how tall the bullet list
          grows on smaller phones (e.g. dynamic type / accessibility
          text). The single-card list keeps the body short enough
          to fit without scrolling on default settings. */}
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          px: 3,
        }}
      >
        <Stack
          spacing={1}
          sx={{
            alignItems: 'center',
            pt: 0.5,
            pb: 3,
            maxWidth: 360,
            mx: 'auto',
            textAlign: 'center',
          }}
        >
          {/* Hero: the "locked Reachy" sticker - a bare Reachy
              head wearing a small padlock badge. The lock signals
              that this surface is about privacy / data boundaries,
              which is exactly what the four bullets below cover
              (mic audio, sandboxed apps, BLE / Wi-Fi scope, HF
              token storage). The asset is a vector SVG so it
              stays crisp at any size and adds zero raster weight.
              Static (not the carousel) because motion on a
              consent surface = distraction while the user is
              reading. */}
          <Box
            component="img"
            src={reachyHeroUrl}
            alt=""
            aria-hidden
            sx={{
              width: 84,
              height: 84,
              objectFit: 'contain',
              display: 'block',
              mb: 0.5,
            }}
          />

          <Typography
            id="eula-title"
            component="h1"
            sx={{
              fontSize: TYPO.hero,
              fontWeight: FONT_WEIGHT.bold,
              letterSpacing: '-0.3px',
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
            }}
          >
            Here&apos;s what Reachy Mini Mobile does, and what we ask of your device.
          </Typography>
        </Stack>

        {/* iOS-Settings-style grouped list: one card, internal
            dividers between rows. Much lighter than four separate
            cards while keeping each disclosure visually distinct.
            `overflow: hidden` clips the dividers and the row hover
            states to the card's rounded corners. The trailing
            margin gives the card breathing room above the sticky
            action plate so the bottom edge of the last bullet
            doesn't kiss the divider line of the CTA. */}
        <Stack
          divider={<Divider flexItem />}
          sx={{
            maxWidth: LAYOUT.contentMaxWidth,
            mx: 'auto',
            mb: 3,
            borderRadius: `${RADIUS.lg}px`,
            bgcolor: 'background.paper',
            border: theme => `1px solid ${theme.palette.divider}`,
            overflow: 'hidden',
          }}
        >
          {BULLETS.map(({ icon: Icon, title, body }) => (
            <Stack
              key={title}
              direction="row"
              spacing={1.5}
              sx={{
                alignItems: 'flex-start',
                px: 1.75,
                py: 1.5,
              }}
            >
              <Icon
                sx={{
                  fontSize: 22,
                  color: 'text.secondary',
                  flexShrink: 0,
                  mt: '2px',
                }}
              />
              <Stack spacing={0.25} sx={{ minWidth: 0 }}>
                <Typography
                  sx={{
                    fontSize: TYPO.body,
                    fontWeight: FONT_WEIGHT.semibold,
                    color: 'text.primary',
                    lineHeight: 1.3,
                  }}
                >
                  {title}
                </Typography>
                <Typography
                  sx={{
                    fontSize: TYPO.sm,
                    color: 'text.secondary',
                    lineHeight: 1.45,
                  }}
                >
                  {body}
                </Typography>
              </Stack>
            </Stack>
          ))}
        </Stack>
      </Box>
      {/* Sticky action plate. `borderTop` paints a soft divider so
          the bar reads as a separate surface from the scrolling
          body. The Privacy / Terms links sit BELOW the CTA in a
          quieter type so the primary affordance stays the single
          obvious next step, while still giving the careful user
          one-tap access to the legal text. */}
      <Box
        sx={{
          px: 3,
          pt: 1.5,
          pb: 0.5,
          borderTop: theme => `1px solid ${theme.palette.divider}`,
          bgcolor: 'background.default',
        }}
      >
        {/* Outlined CTA rather than contained: with primary-coloured
            accents already present in the bullet card (icons stay
            text.secondary by design, so the orange budget is
            spent here and on the lock badge), a filled orange
            button at full width was over-saturating the bottom of
            the screen. The outlined treatment keeps the affordance
            obvious without dominating the visual weight, and
            mirrors the "Edit" chip styling we use elsewhere. */}
        <Button
          fullWidth
          variant="outlined"
          color="primary"
          size="large"
          onClick={onAccept}
          sx={{
            textTransform: 'none',
            fontSize: TYPO.md,
            fontWeight: FONT_WEIGHT.semibold,
            py: 1.25,
            borderRadius: `${RADIUS.md}px`,
            // Keep the outlined treatment legible against the
            // sticky plate's default background: a 1.5px border
            // and a slight tinted hover reads as a primary CTA
            // rather than a secondary chip.
            borderWidth: '1.5px',
            '&:hover': {
              borderWidth: '1.5px',
            },
          }}
        >
          Accept and continue
        </Button>
        <Stack
          direction="row"
          spacing={0.5}
          sx={{
            justifyContent: 'center',
            alignItems: 'center',
            pt: 0.75,
          }}
        >
          <Button
            variant="text"
            size="small"
            onClick={handleOpenPrivacy}
            sx={{
              fontSize: TYPO.xs,
              textTransform: 'none',
              color: 'text.secondary',
              minWidth: 0,
              px: 1,
              py: 0.25,
            }}
          >
            Privacy Policy
          </Button>
          <Box aria-hidden component="span" sx={{ fontSize: TYPO.xs, color: 'text.disabled' }}>
            ·
          </Box>
          <Button
            variant="text"
            size="small"
            onClick={handleOpenTerms}
            sx={{
              fontSize: TYPO.xs,
              textTransform: 'none',
              color: 'text.secondary',
              minWidth: 0,
              px: 1,
              py: 0.25,
            }}
          >
            Terms of Service
          </Button>
        </Stack>
      </Box>
    </Box>
  );
}
