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
 * Play's UGC policy. The sheet is the Apple-friendly contact
 * surface, plus the obvious "where do I go for more info" links:
 *
 *   Get help
 *     - "Contact us"          -> mailto with version pre-filled
 *     - "Troubleshooting"     -> HF docs (reachy_mini)
 *     - "Documentation"       -> HF docs (reachy_mini index)
 *   Community
 *     - "Discord"             -> Pollen community server
 *     - "GitHub"              -> Pollen Robotics org
 *   Legal
 *     - "Privacy Policy"      -> external URL (Pollen-hosted)
 *     - "Terms of Service"    -> external URL (Pollen-hosted)
 *   footer                    -> app version (and a hint that it
 *                                ships with the email so support
 *                                can repro)
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
 * Constants
 * ─────────
 * `SUPPORT_EMAIL`, `PRIVACY_POLICY_URL` and `TERMS_OF_SERVICE_URL`
 * point at the canonical Pollen-hosted resources. The strings are
 * centralised at the top of the file so a future legal revision is
 * a one-constant change.
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
  ListSubheader,
  Stack,
  Typography,
} from '@mui/material';
import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined';
import CloseIcon from '@mui/icons-material/Close';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import GavelOutlinedIcon from '@mui/icons-material/GavelOutlined';
import GitHubIcon from '@mui/icons-material/GitHub';
import MailOutlineIcon from '@mui/icons-material/MailOutline';
import MenuBookOutlinedIcon from '@mui/icons-material/MenuBookOutlined';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import PrivacyTipOutlinedIcon from '@mui/icons-material/PrivacyTipOutlined';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';

import { useHiddenAuthors } from '@/features/apps/useHiddenAuthors';
import { openExternalUrl } from '@/shared/tauri/openUrl';
import { FONT_WEIGHT, LAYOUT, TYPO } from '@/ui/design/tokens';

/**
 * Canonical Pollen Robotics / Hugging Face endpoints.
 *
 * - `SUPPORT_EMAIL` lands in the team's general inbox; the subject
 *   + body template helps us repro fast (version is baked in).
 * - `TROUBLESHOOTING_URL` and `DOCUMENTATION_URL` point at the
 *   Hugging Face-hosted docs for `reachy_mini` (single source of
 *   truth, no Pollen-side mirror to keep in sync).
 * - `DISCORD_URL` and `GITHUB_URL` are the public community
 *   surfaces; the Discord invite is permanent (vanity link).
 * - Both legal URLs are the live Pollen-hosted pages used for the
 *   App Store Privacy Nutrition Label / Play Store Data Safety
 *   form.
 */
const SUPPORT_EMAIL = 'support@pollen-robotics.com';
const TROUBLESHOOTING_URL =
  'https://huggingface.co/docs/reachy_mini/troubleshooting';
const DOCUMENTATION_URL = 'https://huggingface.co/docs/reachy_mini/index';
const DISCORD_URL = 'https://discord.gg/2bAhWfXme9';
const GITHUB_URL = 'https://github.com/pollen-robotics';
const PRIVACY_POLICY_URL =
  'https://www.pollen-robotics.com/personal-data-protection-charter/';
const TERMS_OF_SERVICE_URL =
  'https://www.pollen-robotics.com/general-terms-and-conditions-of-sales/';

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

  // Single helper for plain-URL rows. Keeps each row dumb (tap ->
  // browser -> dismiss sheet) and avoids a callback per item. The
  // label is only used for the warn line so support can tell us
  // which row failed.
  const handleOpenUrl = useCallback(
    async (label: string, url: string): Promise<void> => {
      try {
        await openExternalUrl(url);
      } catch (err) {
        console.warn(`[help] ${label} URL failed:`, err);
      }
      onClose();
    },
    [onClose],
  );

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
          // Group headers (`Get help`, `Community`, `Legal`) share
          // a single visual treatment: small caps-ish label,
          // muted, slightly tighter vertical rhythm than the
          // rows. Defined once on the parent to keep markup
          // light.
          '& .MuiListSubheader-root': {
            bgcolor: 'background.paper',
            color: 'text.secondary',
            fontSize: TYPO.tiny,
            fontWeight: FONT_WEIGHT.semibold,
            letterSpacing: '0.6px',
            textTransform: 'uppercase',
            lineHeight: 1.2,
            px: 2,
            pt: 2,
            pb: 0.75,
          },
        }}
      >
        {/* Group 1 - Get help.
            "Talk to us, or read what we already wrote." This is
            the primary intent of the sheet (Apple UGC contact
            surface) so it sits first. */}
        <ListSubheader disableSticky>Get help</ListSubheader>
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

        <ListItemButton
          onClick={() => handleOpenUrl('troubleshooting', TROUBLESHOOTING_URL)}
        >
          <ListItemIcon sx={{ minWidth: 40 }}>
            <BuildOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary="Troubleshooting"
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

        <ListItemButton
          onClick={() => handleOpenUrl('documentation', DOCUMENTATION_URL)}
        >
          <ListItemIcon sx={{ minWidth: 40 }}>
            <MenuBookOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary="Documentation"
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

        {/* Group 2 - Community.
            Discord + GitHub. Discord is the canonical place to
            ask questions or share builds with other owners;
            GitHub is for issues / code. Both are public surfaces
            so they don't need a UGC moderation note. */}
        <ListSubheader disableSticky>Community</ListSubheader>
        <ListItemButton onClick={() => handleOpenUrl('discord', DISCORD_URL)}>
          <ListItemIcon sx={{ minWidth: 40 }}>
            <ForumOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary="Discord"
            secondary="Join the community"
            primaryTypographyProps={{
              fontSize: TYPO.md,
              fontWeight: FONT_WEIGHT.medium,
            }}
            secondaryTypographyProps={{
              fontSize: TYPO.xs,
              color: 'text.secondary',
            }}
          />
          <OpenInNewIcon
            fontSize="small"
            sx={{ color: 'text.secondary', ml: 1 }}
          />
        </ListItemButton>
        <Divider component="li" />

        <ListItemButton onClick={() => handleOpenUrl('github', GITHUB_URL)}>
          <ListItemIcon sx={{ minWidth: 40 }}>
            <GitHubIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary="GitHub"
            secondary="pollen-robotics"
            primaryTypographyProps={{
              fontSize: TYPO.md,
              fontWeight: FONT_WEIGHT.medium,
            }}
            secondaryTypographyProps={{
              fontSize: TYPO.xs,
              color: 'text.secondary',
            }}
          />
          <OpenInNewIcon
            fontSize="small"
            sx={{ color: 'text.secondary', ml: 1 }}
          />
        </ListItemButton>

        {/* Group 3 - Legal.
            Privacy + Terms last, both because they're the least
            frequently tapped and because Apple / Play reviewers
            scan for them at the bottom of similar surfaces. */}
        <ListSubheader disableSticky>Legal</ListSubheader>
        <ListItemButton
          onClick={() => handleOpenUrl('privacy', PRIVACY_POLICY_URL)}
        >
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

        <ListItemButton
          onClick={() => handleOpenUrl('terms', TERMS_OF_SERVICE_URL)}
        >
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
