/**
 * Bottom-of-list "create your own" footer.
 *
 * Mounted at the very end of the Apps tab's browse list, after
 * every category rail has been rendered. Adapted from the desktop
 * app's `application-store/modals/CreateAppTutorial.tsx` modal
 * (which surfaces three tutorial steps Explore / Build / Deploy).
 * On mobile we keep only the central "Build" call to action -
 * the Explore (REST API) and Deploy (HF Spaces blog) detours
 * read as noise on a phone surface, where the user is already
 * one tap away from the canonical docs and what they really
 * need is the "I want to build one" entry point.
 *
 *   ┌──────────────────────────────────────────┐
 *   │                                          │
 *   │            ╭───────────╮                 │
 *   │            │   illu    │                 │
 *   │            ╰───────────╯                 │
 *   │                                          │
 *   │       Want to create your own?           │
 *   │   Build, share and publish your own      │
 *   │           apps for Reachy Mini.          │
 *   │                                          │
 *   │          [ Get started →  ]              │
 *   │                                          │
 *   └──────────────────────────────────────────┘
 *
 * The CTA opens the HF docs "Apps & Ecosystem" anchor (same
 * destination as the small `AppCreateYourOwnTile` at the end of
 * each rail and the website's matching "Want to create your own
 * apps?" CTA), which sits inside the `huggingface.co/*` slice
 * of the Tauri opener allowlist.
 */
import { Box, Button, Stack, Typography, keyframes } from '@mui/material';
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded';

import reachyHowToCreateAppUrl from '@/assets/reachy-how-to-create-app.svg';
import { openExternalUrl } from '@/shared/tauri/openUrl';
import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';

// Canonical "create your own apps" entry point on the HF docs.
// Kept on the `huggingface.co/*` domain because the Tauri opener
// plugin's allowlist (`src-tauri/capabilities/default.json`) only
// whitelists HF hosts - the GitHub `docs/SDK/` URL the desktop
// tutorial points at would throw silently on mobile. The HF page
// already deep-links to the SDK section via the anchor, so the
// destination is equivalent for the user.
const CREATE_GUIDE_URL =
  'https://huggingface.co/docs/reachy_mini/index#-apps--ecosystem';

// Gentle float for the hero illustration. Matches the other
// hero illustrations across the app (`HeroIllustration` uses
// the same 4s ease-in-out cadence) so the section feels of a
// piece with the rest of the shell.
const floatKf = keyframes`
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-6px); }
`;

export default function AppsCreateFooter() {
  const handleOpen = async () => {
    try {
      await openExternalUrl(CREATE_GUIDE_URL);
    } catch (err) {
      // Surface the failure in the console instead of swallowing
      // it: the most common cause is a URL falling outside the
      // Tauri opener allowlist, and a silent no-op makes that
      // very painful to debug from the IDE.
      console.error('[AppsCreateFooter] failed to open guide URL:', err);
    }
  };

  return (
    <Stack
      spacing={2.5}
      alignItems="center"
      sx={(theme) => ({
        pt: 4,
        pb: 4,
        px: 3,
        width: '100%',
        borderRadius: `${RADIUS.xxl}px`,
        // Plain paper surface (white in light mode, near-black
        // in dark mode) so the section reads as a clean panel
        // and the outlined-primary CTA carries the colour weight.
        bgcolor: 'background.paper',
        border: `1px solid ${theme.palette.divider}`,
        textAlign: 'center',
      })}
    >
      <Box
        sx={{
          width: 150,
          height: 150,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          animation: `${floatKf} 4s ease-in-out infinite`,
          '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
        }}
      >
        <img
          src={reachyHowToCreateAppUrl}
          alt=""
          aria-hidden
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            userSelect: 'none',
            pointerEvents: 'none',
          }}
        />
      </Box>

      <Stack spacing={1} sx={{ maxWidth: 340 }}>
        <Typography
          sx={{
            fontSize: TYPO.hero,
            fontWeight: FONT_WEIGHT.bold,
            color: 'text.primary',
            letterSpacing: '-0.5px',
            lineHeight: 1.15,
          }}
        >
          Want to create your own?
        </Typography>
        <Typography
          sx={{
            fontSize: TYPO.body,
            color: 'text.secondary',
            lineHeight: 1.5,
          }}
        >
          Build, share and publish your own apps for Reachy Mini.
        </Typography>
      </Stack>

      <Button
        variant="outlined"
        color="primary"
        size="large"
        endIcon={<ArrowForwardRoundedIcon sx={{ fontSize: TYPO.lg }} />}
        onClick={() => {
          void handleOpen();
        }}
        aria-label="Open the Reachy Mini create-your-own-app guide"
        sx={{
          mt: 1,
          textTransform: 'none',
          fontSize: TYPO.md,
          fontWeight: FONT_WEIGHT.semibold,
          // Slightly thicker stroke + bigger pill so the CTA reads
          // as the section's primary action, matching the App
          // Store / Apple Music "Get" button gravity.
          borderWidth: 1.5,
          borderRadius: `${RADIUS.pill}px`,
          px: 3,
          py: 1,
          '&:hover': { borderWidth: 1.5 },
          '&:active': { borderWidth: 1.5 },
          '& .MuiButton-endIcon': { ml: 0.5 },
        }}
      >
        Get started
      </Button>
    </Stack>
  );
}
