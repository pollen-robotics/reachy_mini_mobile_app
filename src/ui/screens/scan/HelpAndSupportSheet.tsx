/**
 * Bottom-sheet presented from the `HfAccountBar` "help" affordance
 * on the `ScanScreen`.
 *
 * Why this sheet exists
 * ─────────────────────
 * Apple App Review guideline 1.2 (User Generated Content) requires
 * the host app to publish "easily accessible contact information"
 * for users who want to escalate beyond the per-app Report flow
 * (`AppActionsMenu`). The same guideline is mirrored on Google
 * Play's UGC policy. Today the mobile app exposes none of this -
 * the sheet is the minimal Apple-friendly contact surface:
 *
 *   - "Contact us"        -> mailto with version + commit pre-filled
 *   - "Privacy Policy"    -> external URL (Pollen-hosted)
 *   - "Terms of Service"  -> external URL (Pollen-hosted)
 *   - footer              -> app version (and a hint that it ships
 *                            with the email so support can repro)
 *
 * Why a Drawer (bottom)
 * ─────────────────────
 * On phones, an action sheet from the bottom is the native iOS /
 * Material 3 pattern for "a small list of choices that aren't a
 * full screen". Cheaper to dismiss than a full-screen settings
 * route, and our design tokens (corner radius, divider rhythm) are
 * already calibrated for that surface. We keep the implementation
 * dumb: no state shared with anything else, no async work, no
 * navigation. Tap an item -> system browser / mail composer.
 *
 * Layer placement
 * ───────────────
 * Co-located with `ScanScreen` because that's the only consumer.
 * Per `AGENTS.md`: keep components in their host until a second
 * consumer appears. If a future Settings entry lives in
 * `RobotSessionScreen`, this sheet graduates to
 * `ui/widgets/help-and-support/`.
 *
 * Placeholders
 * ────────────
 * `SUPPORT_EMAIL`, `PRIVACY_POLICY_URL` and `TERMS_OF_SERVICE_URL`
 * are TODO placeholders. The strings are deliberately centralised
 * at the top of the file so legal can hand us the canonical URLs
 * and we update one constant each. Until then the privacy / terms
 * items still RENDER and still BEHAVE (open the placeholder URL),
 * so the contact surface is testable end-to-end on TestFlight.
 */
import { useCallback } from 'react';
import {
  Box,
  Button,
  Chip,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import GavelOutlinedIcon from '@mui/icons-material/GavelOutlined';
import MailOutlineIcon from '@mui/icons-material/MailOutline';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import PrivacyTipOutlinedIcon from '@mui/icons-material/PrivacyTipOutlined';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';

import { useHiddenAuthors } from '@/features/apps/useHiddenAuthors';
import { openExternalUrl } from '@/shared/tauri/openUrl';
import { FONT_WEIGHT, LAYOUT, TYPO } from '@/ui/design/tokens';

/**
 * TODO(legal): confirm the canonical addresses below before the
 * first public store submission.
 *
 * - The email lands in the team's general support inbox; the
 *   subject + body template helps us repro fast (version + commit
 *   are baked in).
 * - The two URLs need to be live by the time we hit App Review
 *   because the Privacy Nutrition Label / Data Safety form on the
 *   stores requires a public privacy policy URL.
 */
const SUPPORT_EMAIL = 'mobile@pollen-robotics.com';
const PRIVACY_POLICY_URL = 'https://pollen-robotics.com/privacy';
const TERMS_OF_SERVICE_URL = 'https://pollen-robotics.com/terms';

interface HelpAndSupportSheetProps {
  open: boolean;
  onClose: () => void;
}

export default function HelpAndSupportSheet({
  open,
  onClose,
}: HelpAndSupportSheetProps) {
  const hiddenAuthors = useHiddenAuthors();

  const handleContact = useCallback(async () => {
    // Pre-fill the email with the build identifiers the support
    // team will ask for first ("what version? what commit?"). The
    // version is the Vite-injected `__APP_VERSION__` (sourced from
    // `package.json`); we don't have a commit hash injected today
    // so we leave a placeholder that the user can fill, or that
    // we fill via a future `VITE_GIT_SHA` define.
    const subject = encodeURIComponent('Reachy Mini Mobile - support');
    const body = encodeURIComponent(
      [
        'Hi Pollen team,',
        '',
        '',
        '---',
        `App version: ${__APP_VERSION__}`,
        'Device: ',
        'OS: ',
      ].join('\n'),
    );
    const mailto = `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
    try {
      await openExternalUrl(mailto);
    } catch (err) {
      // mailto can fail on a device that has no default mail
      // client configured (rare on iOS, possible on Android).
      // Logging keeps the failure visible without aborting the
      // sheet's UX flow.
      console.warn('[help] mailto failed:', err);
    }
    onClose();
  }, [onClose]);

  const handleOpenPrivacy = useCallback(async () => {
    try {
      await openExternalUrl(PRIVACY_POLICY_URL);
    } catch (err) {
      console.warn('[help] privacy URL failed:', err);
    }
    onClose();
  }, [onClose]);

  const handleOpenTerms = useCallback(async () => {
    try {
      await openExternalUrl(TERMS_OF_SERVICE_URL);
    } catch (err) {
      console.warn('[help] terms URL failed:', err);
    }
    onClose();
  }, [onClose]);

  return (
    <Drawer
      anchor="bottom"
      open={open}
      onClose={onClose}
      slotProps={{
        paper: {
          sx: {
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            // Bottom safe-area padding so the last list item is
            // not hidden under the home indicator on devices with
            // gesture navigation.
            pb: `calc(${LAYOUT.safeAreaBottom} + 8px)`,
            bgcolor: 'background.paper',
          },
        },
      }}
    >
      {/* Sheet header. Title flush left, close button flush right.
          Mirrors the AppIframeOverlay top bar so the mobile UI
          feels coherent across sheets. */}
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{
          px: 2,
          pt: 1.75,
          pb: 1,
        }}
      >
        <Typography
          component="h2"
          sx={{
            fontSize: TYPO.body,
            fontWeight: FONT_WEIGHT.semibold,
            color: 'text.primary',
          }}
        >
          Help &amp; Support
        </Typography>
        <IconButton
          aria-label="Close help and support"
          size="small"
          onClick={onClose}
          edge="end"
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Stack>
      <Divider />

      <List
        disablePadding
        sx={{
          // Adopt the same divider rhythm we use elsewhere: a thin
          // hairline between rows, no inset on the divider so the
          // line spans the full sheet width.
          '& .MuiListItemButton-root': {
            px: 2,
            py: 1.5,
          },
        }}
      >
        <ListItemButton onClick={handleContact}>
          <ListItemIcon sx={{ minWidth: 40 }}>
            <MailOutlineIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary="Contact us"
            secondary={SUPPORT_EMAIL}
            primaryTypographyProps={{
              fontSize: TYPO.md,
              fontWeight: FONT_WEIGHT.medium,
            }}
            secondaryTypographyProps={{
              fontSize: TYPO.xs,
              color: 'text.secondary',
            }}
          />
        </ListItemButton>
        <Divider component="li" />

        <ListItemButton onClick={handleOpenPrivacy}>
          <ListItemIcon sx={{ minWidth: 40 }}>
            <PrivacyTipOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary="Privacy Policy"
            primaryTypographyProps={{
              fontSize: TYPO.md,
              fontWeight: FONT_WEIGHT.medium,
            }}
          />
          <OpenInNewIcon
            fontSize="small"
            sx={{ color: 'text.secondary', ml: 1 }}
          />
        </ListItemButton>
        <Divider component="li" />

        <ListItemButton onClick={handleOpenTerms}>
          <ListItemIcon sx={{ minWidth: 40 }}>
            <GavelOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary="Terms of Service"
            primaryTypographyProps={{
              fontSize: TYPO.md,
              fontWeight: FONT_WEIGHT.medium,
            }}
          />
          <OpenInNewIcon
            fontSize="small"
            sx={{ color: 'text.secondary', ml: 1 }}
          />
        </ListItemButton>
      </List>

      {/* Hidden authors revoke list. The "Hide apps from <author>"
          affordance in `AppActionsMenu` is one-way from the user's
          perspective unless we surface a way to undo it; this is
          that surface. The list shows up only when there's at
          least one entry, so the sheet stays compact for the
          common case.

          Apple's UGC review specifically asks where the user can
          revoke a block they made by mistake. Pointing at this
          section in the App Review Notes ("Help & Support ->
          Hidden authors") is the cleanest answer. */}
      {hiddenAuthors.ids.length > 0 && (
        <>
          <Divider />
          <Box sx={{ px: 2, pt: 2, pb: 1.5 }}>
            <Stack
              direction="row"
              alignItems="center"
              justifyContent="space-between"
              sx={{ mb: 1 }}
            >
              <Stack direction="row" alignItems="center" spacing={1}>
                <VisibilityOffOutlinedIcon
                  fontSize="small"
                  sx={{ color: 'text.secondary' }}
                />
                <Typography
                  sx={{
                    fontSize: TYPO.sm,
                    fontWeight: FONT_WEIGHT.semibold,
                    color: 'text.primary',
                  }}
                >
                  Hidden authors
                </Typography>
              </Stack>
              <Button
                size="small"
                onClick={() => hiddenAuthors.clear()}
                sx={{
                  fontSize: TYPO.xs,
                  textTransform: 'none',
                  color: 'text.secondary',
                  minWidth: 0,
                  px: 1,
                }}
              >
                Show all
              </Button>
            </Stack>
            <Typography
              sx={{
                fontSize: TYPO.xs,
                color: 'text.secondary',
                mb: 1.25,
              }}
            >
              Tap the cross to show this author&apos;s apps again.
            </Typography>
            {/* Chip cluster: each chip is one author, deletable to
                reveal them again. Chip's `onDelete` renders a small
                close icon on the right that fires the callback;
                the body of the chip is non-interactive (no need to
                navigate anywhere - the catalog Hub page lives
                elsewhere via the per-app menu). */}
            <Box
              sx={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 0.75,
              }}
            >
              {hiddenAuthors.ids.map((author) => (
                <Chip
                  key={author}
                  label={author}
                  variant="outlined"
                  size="small"
                  onDelete={() => hiddenAuthors.unhide(author)}
                  sx={{
                    fontFamily: 'monospace',
                    fontSize: TYPO.xs,
                  }}
                />
              ))}
            </Box>
          </Box>
        </>
      )}

      {/* Footer: version line, mostly for support emails. The
          string is the same `__APP_VERSION__` baked into the
          splash screen, so the user can copy it from either
          place. Kept dim because it's a self-debug aid, not a
          headline. */}
      <Box
        sx={{
          px: 2,
          pt: 2,
          pb: 1,
          borderTop: theme => `1px solid ${theme.palette.divider}`,
        }}
      >
        <Typography
          sx={{
            fontSize: TYPO.tiny,
            color: 'text.disabled',
            fontFamily: 'monospace',
            textAlign: 'center',
          }}
        >
          Reachy Mini Mobile v{__APP_VERSION__}
        </Typography>
      </Box>
    </Drawer>
  );
}
