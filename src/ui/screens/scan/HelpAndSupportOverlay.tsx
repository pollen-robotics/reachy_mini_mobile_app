/**
 * Help & Support overlay (replaces the earlier bottom-sheet
 * `HelpAndSupportSheet`).
 *
 * Visually a sibling of `RobotInfoPanel`: a self-sized flex column
 * (`height: 100%`) whose host (`ScanScreen`) places it via a
 * `position: fixed` wrapper that sits BELOW the `HfAccountBar`,
 * covering body + sticky refresh bar but NOT the topbar. That
 * keeps the avatar / username / sign-out + help-close button
 * visible while the overlay is open, so a second tap on the
 * help button (whose glyph swaps to `✕` while the overlay is up)
 * dismisses the panel from the same spot the user opened it from.
 *
 *   ┌──────────────────────────────────────┐
 *   │ ⟵ HfAccountBar stays visible    [✕] │  (NOT painted here)
 *   ├──────────────────────────────────────┤
 *   │  APPEARANCE                          │
 *   │  ┌─────────────────────────────────┐ │
 *   │  │ [System] [Light]   [Dark]       │ │
 *   │  └─────────────────────────────────┘ │
 *   │  GET HELP                            │
 *   │  ┌─────────────────────────────────┐ │
 *   │  │ ✉ Contact us           support…│ │
 *   │  │ 🛠 Troubleshooting        ↗    │ │
 *   │  │ 📖 Documentation          ↗    │ │
 *   │  └─────────────────────────────────┘ │
 *   │  COMMUNITY                           │
 *   │  ┌─────────────────────────────────┐ │
 *   │  │ 💬 Discord    Join…       ↗    │ │
 *   │  │  GitHub  pollen-robotics   ↗   │ │
 *   │  └─────────────────────────────────┘ │
 *   │  LEGAL                               │
 *   │  ┌─────────────────────────────────┐ │
 *   │  │ 🔒 Privacy Policy         ↗    │ │
 *   │  │ ⚖ Terms of Service        ↗    │ │
 *   │  └─────────────────────────────────┘ │
 *   │  HIDDEN AUTHORS (if any)             │
 *   │  ┌─────────────────────────────────┐ │
 *   │  │  [author x] [author y] [Clear]  │ │
 *   │  └─────────────────────────────────┘ │
 *   │            Reachy Mini Mobile v…     │
 *   └──────────────────────────────────────┘
 *
 * Apple App Review guideline 1.2 (UGC) requires the host app to
 * publish "easily accessible contact information"; this overlay is
 * the Apple-friendly contact surface plus the obvious "where do I
 * go for more info" links. Same content as the previous
 * `HelpAndSupportSheet`, restyled to match `RobotInfoPanel`.
 *
 * Constants are kept centralised at the top of the file so a
 * future legal revision is a one-constant change.
 */
import { useCallback, type MouseEvent } from 'react';
import {
  Box,
  Button,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined';
import DarkModeOutlinedIcon from '@mui/icons-material/DarkModeOutlined';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import GavelOutlinedIcon from '@mui/icons-material/GavelOutlined';
import GitHubIcon from '@mui/icons-material/GitHub';
import LightModeOutlinedIcon from '@mui/icons-material/LightModeOutlined';
import MailOutlineIcon from '@mui/icons-material/MailOutlineOutlined';
import MenuBookOutlinedIcon from '@mui/icons-material/MenuBookOutlined';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import PersonOutlineRoundedIcon from '@mui/icons-material/PersonOutlineRounded';
import PrivacyTipOutlinedIcon from '@mui/icons-material/PrivacyTipOutlined';
import SettingsBrightnessOutlinedIcon from '@mui/icons-material/SettingsBrightnessOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';

import { useHiddenAuthors } from '@/features/apps/useHiddenAuthors';
import { setThemeMode, useThemeMode, type ThemeMode } from '@/features/theme-preference';
import { openExternalUrl } from '@/shared/tauri/openUrl';
import Section from '@/ui/design/Section';
import { FONT_WEIGHT, LAYOUT, TYPO } from '@/ui/design/tokens';

const SUPPORT_EMAIL = 'support@pollen-robotics.com';
const TROUBLESHOOTING_URL = 'https://huggingface.co/docs/reachy_mini/troubleshooting';
const DOCUMENTATION_URL = 'https://huggingface.co/docs/reachy_mini/index';
const DISCORD_URL = 'https://discord.gg/2bAhWfXme9';
const GITHUB_URL = 'https://github.com/pollen-robotics';
const PRIVACY_POLICY_URL = 'https://www.pollen-robotics.com/personal-data-protection-charter/';
const TERMS_OF_SERVICE_URL =
  'https://www.pollen-robotics.com/general-terms-and-conditions-of-sales/';

interface HelpAndSupportOverlayProps {
  /**
   * Dismiss callback. Wired to the host's `helpOpen` toggle. The
   * overlay does not paint its own close button (the topbar's
   * help-icon → cross swap carries that affordance), but we keep
   * the prop on the API so any future inline action that needs to
   * dismiss the overlay after completion can do so.
   */
  onClose: () => void;
}

export default function HelpAndSupportOverlay({ onClose }: HelpAndSupportOverlayProps) {
  const hiddenAuthors = useHiddenAuthors();
  const themeMode = useThemeMode();

  // Toggle handler. The MUI ToggleButtonGroup signature passes
  // `null` when the user taps the already-selected button (with
  // `exclusive`), which we want to ignore - the appearance is
  // never "unset", only switched between three concrete options.
  const handleThemeModeChange = useCallback(
    (_event: MouseEvent<HTMLElement>, next: ThemeMode | null) => {
      if (next === null) return;
      setThemeMode(next);
    },
    []
  );

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
      ].join('\n')
    );
    const mailto = `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
    try {
      await openExternalUrl(mailto);
    } catch (err) {
      // mailto can fail on a device that has no default mail
      // client configured (rare on iOS, possible on Android).
      // Logging keeps the failure visible without aborting the
      // overlay's UX flow.
      console.warn('[help] mailto failed:', err);
    }
    onClose();
  }, [onClose]);

  // Single helper for plain-URL rows. Keeps each row dumb (tap ->
  // browser -> dismiss overlay) and avoids a callback per item.
  // The label is only used for the warn line so support can tell
  // us which row failed.
  const handleOpenUrl = useCallback(
    async (label: string, url: string): Promise<void> => {
      try {
        await openExternalUrl(url);
      } catch (err) {
        console.warn(`[help] ${label} URL failed:`, err);
      }
      onClose();
    },
    [onClose]
  );

  return (
    <Stack
      sx={{
        height: '100%',
        width: '100%',
        // Same `background.default` the panel host gets in
        // `RobotInfoPanel` - the overlay reads as "a screen", with
        // each `<Section>` carrying its own `background.paper`
        // sub-card on top of this matte canvas.
        bgcolor: 'background.default',
      }}
    >
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          px: 2,
          pt: 2,
          // Bottom safe-area padding so the version footer isn't
          // tucked under the iOS home indicator on gesture-nav
          // devices. The host (`ScanScreen`) wraps us in a
          // `position: fixed` Box that goes all the way to the
          // viewport bottom, including over the sticky refresh
          // bar - we own our bottom inset directly.
          pb: `calc(${LAYOUT.safeAreaBottom} + 16px)`,
          overflowY: 'auto',
        }}
      >
        {/* Appearance. Light / Dark / System theme picker. Lives
            first because it's a personal preference users actively
            tweak, unlike the help links below which are
            tap-once-and-forget. The three-way `ToggleButtonGroup`
            mirrors iOS Settings -> Display & Brightness and the
            Android system theme picker, so the affordance reads
            as native on both platforms. */}
        <Section label="Appearance">
          <Box sx={{ p: 1.5 }}>
            <ToggleButtonGroup
              value={themeMode}
              exclusive
              onChange={handleThemeModeChange}
              aria-label="App theme"
              fullWidth
              size="small"
              sx={{
                '& .MuiToggleButton-root': {
                  textTransform: 'none',
                  fontSize: TYPO.sm,
                  fontWeight: FONT_WEIGHT.medium,
                  py: 1,
                  gap: 0.75,
                  color: 'text.secondary',
                  borderColor: 'divider',
                  '&.Mui-selected': {
                    bgcolor: 'action.selected',
                    color: 'text.primary',
                    fontWeight: FONT_WEIGHT.semibold,
                  },
                },
              }}
            >
              <ToggleButton value="system" aria-label="Match system theme">
                <SettingsBrightnessOutlinedIcon fontSize="small" />
                System
              </ToggleButton>
              <ToggleButton value="light" aria-label="Light theme">
                <LightModeOutlinedIcon fontSize="small" />
                Light
              </ToggleButton>
              <ToggleButton value="dark" aria-label="Dark theme">
                <DarkModeOutlinedIcon fontSize="small" />
                Dark
              </ToggleButton>
            </ToggleButtonGroup>
          </Box>
        </Section>

        {/* Get help. "Talk to us, or read what we already wrote."
            Primary intent of the overlay (Apple UGC contact
            surface), so this section is first among the
            help-oriented groups. */}
        <Section label="Get help">
          <ActionRow
            icon={<MailOutlineIcon fontSize="small" />}
            label="Contact us"
            caption={SUPPORT_EMAIL}
            onTap={() => void handleContact()}
          />
          <ActionRow
            icon={<BuildOutlinedIcon fontSize="small" />}
            label="Troubleshooting"
            external
            onTap={() => void handleOpenUrl('troubleshooting', TROUBLESHOOTING_URL)}
          />
          <ActionRow
            icon={<MenuBookOutlinedIcon fontSize="small" />}
            label="Documentation"
            external
            onTap={() => void handleOpenUrl('documentation', DOCUMENTATION_URL)}
          />
        </Section>

        {/* Community. Discord + GitHub. Discord is the canonical
            place to ask questions or share builds with other
            owners; GitHub is for issues / code. Both are public
            surfaces so they don't need a UGC moderation note. */}
        <Section label="Community">
          <ActionRow
            icon={<ForumOutlinedIcon fontSize="small" />}
            label="Discord"
            caption="Join the community"
            external
            onTap={() => void handleOpenUrl('discord', DISCORD_URL)}
          />
          <ActionRow
            icon={<GitHubIcon fontSize="small" />}
            label="GitHub"
            caption="pollen-robotics"
            external
            onTap={() => void handleOpenUrl('github', GITHUB_URL)}
          />
        </Section>

        {/* Legal. Privacy + Terms last, both because they're the
            least frequently tapped and because Apple / Play
            reviewers scan for them at the bottom of similar
            surfaces. */}
        <Section label="Legal">
          <ActionRow
            icon={<PrivacyTipOutlinedIcon fontSize="small" />}
            label="Privacy Policy"
            external
            onTap={() => void handleOpenUrl('privacy', PRIVACY_POLICY_URL)}
          />
          <ActionRow
            icon={<GavelOutlinedIcon fontSize="small" />}
            label="Terms of Service"
            external
            onTap={() => void handleOpenUrl('terms', TERMS_OF_SERVICE_URL)}
          />
        </Section>

        {/* Hidden authors revoke list. The "Hide apps from
            <author>" affordance in `AppActionsMenu` is one-way
            from the user's perspective unless we surface a way
            to undo it; this is that surface. The section shows
            up only when there's at least one entry, so the
            overlay stays compact for the common case.
            Apple's UGC review specifically asks where the user
            can revoke a block they made by mistake. Pointing at
            this section in the App Review Notes ("Help & Support
            -> Hidden authors") is the cleanest answer. */}
        {hiddenAuthors.ids.length > 0 && (
          <Section label="Hidden authors">
            {/* Header row: short caption + "Show all" reset. The
                caption uses the same surface-text colour as the
                other section bodies so it visually anchors as a
                sub-header rather than a tappable row. */}
            <Box
              sx={theme => ({
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                px: 1.5,
                py: 1.25,
                borderBottom: `1px solid ${theme.palette.divider}`,
              })}
            >
              <Typography
                sx={{
                  flex: 1,
                  fontSize: TYPO.xs,
                  color: 'text.secondary',
                  lineHeight: 1.4,
                }}
              >
                Tap <Box component="span" sx={{ fontWeight: FONT_WEIGHT.semibold, color: 'text.primary' }}>Show again</Box> to bring an author&apos;s apps back to the catalog.
              </Typography>
              {hiddenAuthors.ids.length > 1 && (
                <Button
                  size="small"
                  onClick={() => hiddenAuthors.clear()}
                  sx={{
                    flexShrink: 0,
                    fontSize: TYPO.xs,
                    fontWeight: FONT_WEIGHT.semibold,
                    textTransform: 'none',
                    color: 'text.secondary',
                    minWidth: 0,
                    px: 1,
                  }}
                >
                  Show all
                </Button>
              )}
            </Box>
            {/* One row per hidden author. Same visual rhythm as
                the other settings rows in this overlay (48 px
                min height, divider between rows, edge-to-edge),
                with a clear "Show again" outlined button on the
                right so the unhide affordance is unambiguous. */}
            {hiddenAuthors.ids.map(author => (
              <Box
                key={author}
                sx={theme => ({
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.25,
                  px: 1.5,
                  py: 1,
                  minHeight: 52,
                  '&:not(:last-of-type)': {
                    borderBottom: `1px solid ${theme.palette.divider}`,
                  },
                })}
              >
                <Box
                  sx={{
                    flexShrink: 0,
                    color: 'text.secondary',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 24,
                    height: 24,
                  }}
                >
                  <PersonOutlineRoundedIcon fontSize="small" />
                </Box>
                <Typography
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    fontFamily: 'monospace',
                    fontSize: TYPO.sm,
                    fontWeight: FONT_WEIGHT.semibold,
                    color: 'text.primary',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {author}
                </Typography>
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<VisibilityOutlinedIcon sx={{ fontSize: TYPO.md }} />}
                  onClick={() => hiddenAuthors.unhide(author)}
                  aria-label={`Show apps from ${author} again`}
                  sx={{
                    flexShrink: 0,
                    fontSize: TYPO.xs,
                    fontWeight: FONT_WEIGHT.semibold,
                    textTransform: 'none',
                    borderWidth: 1.5,
                    '&:hover': { borderWidth: 1.5 },
                    '& .MuiButton-startIcon': { mr: 0.5 },
                  }}
                >
                  Show again
                </Button>
              </Box>
            ))}
          </Section>
        )}

        {/* Version footer. Mostly for support emails. The string
            is the same `__APP_VERSION__` baked into the splash
            screen so the user can copy it from either place. Dim
            because it's a self-debug aid, not a headline. */}
        <Typography
          aria-label="App version"
          sx={{
            mt: 1,
            fontSize: TYPO.tiny,
            color: 'text.disabled',
            fontFamily: 'monospace',
            textAlign: 'center',
          }}
        >
          Reachy Mini Mobile v{__APP_VERSION__}
        </Typography>
      </Box>
    </Stack>
  );
}

/**
 * Tappable "action row" inside a `<Section>`. Layout mirrors a
 * settings cell:
 *
 *   ┌──────────────────────────────────────┐
 *   │ [icon]  Label                ↗ / ›  │
 *   │         Optional caption             │
 *   └──────────────────────────────────────┘
 *
 * The row itself is the tap target (focusable, Enter / Space
 * handlers). `external` swaps the trailing glyph from a chevron-
 * style `›` (implicit, omitted today) to an `OpenInNew` arrow,
 * mirroring iOS Settings' "external link" convention so the user
 * knows the tap will leave the app for the system browser. The
 * row owns its bottom divider via `:not(:last-of-type)` so
 * consecutive rows inside a `<Section>` stack cleanly without the
 * Section having to inject separators between siblings.
 */
function ActionRow({
  icon,
  label,
  caption,
  external = false,
  onTap,
}: {
  icon: React.ReactNode;
  label: string;
  caption?: string;
  external?: boolean;
  onTap: () => void;
}) {
  return (
    <Box
      role="button"
      tabIndex={0}
      aria-label={caption ? `${label} (${caption})` : label}
      onClick={onTap}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onTap();
        }
      }}
      sx={theme => ({
        display: 'flex',
        alignItems: 'center',
        gap: 1.25,
        px: 1.5,
        py: 1.25,
        minHeight: 48,
        cursor: 'pointer',
        userSelect: 'none',
        WebkitTapHighlightColor: 'transparent',
        '&:not(:last-of-type)': {
          borderBottom: `1px solid ${theme.palette.divider}`,
        },
        '&:active': {
          bgcolor: 'action.hover',
        },
        '&:focus-visible': {
          outline: `2px solid ${theme.palette.primary.main}`,
          outlineOffset: -2,
        },
      })}
    >
      <Box
        sx={{
          flexShrink: 0,
          color: 'text.secondary',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
        }}
      >
        {icon}
      </Box>
      <Stack sx={{ flex: 1, minWidth: 0 }} spacing={0.125}>
        <Typography
          component="span"
          sx={{
            fontSize: TYPO.md,
            fontWeight: FONT_WEIGHT.medium,
            color: 'text.primary',
            lineHeight: 1.3,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </Typography>
        {caption && (
          <Typography
            component="span"
            sx={{
              fontSize: TYPO.xs,
              color: 'text.secondary',
              lineHeight: 1.3,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {caption}
          </Typography>
        )}
      </Stack>
      {external && (
        // No tooltip - the `↗` glyph is universally read as
        // "external link", and on touch a Tooltip would only
        // surface on long-press, which nobody discovers. The
        // icon alone is the affordance; `aria-hidden` keeps
        // screen readers from announcing the redundant glyph
        // (the row's accessible name already carries the link
        // target).
        <OpenInNewIcon
          aria-hidden
          sx={{
            flexShrink: 0,
            fontSize: 16,
            color: 'text.disabled',
          }}
        />
      )}
    </Box>
  );
}
