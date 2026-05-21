/**
 * Per-app actions menu (the "..." kebab on tiles + iframe overlay).
 *
 * Why this exists
 * ───────────────
 * Apple App Review guideline 1.2 (User Generated Content) requires
 * a clearly-labelled "report" affordance on every surface where the
 * user consumes UGC. Our UGC surfaces are:
 *
 *   - The catalog tiles (`AppCompactTile`) - reading metadata.
 *   - The launched iframe (`AppIframeOverlay`) - using the app.
 *
 * Both surfaces mount this menu so the same "Report this app" /
 * "View on Hugging Face" actions are reachable wherever the user
 * first notices the issue.
 *
 * Three actions
 * ─────────────
 *   - "Report this app" -> Apple 1.2 pillar #2 (report mechanism).
 *     Deeplinks to `<spaceUrl>?report=true` in the system browser
 *     so HF Trust & Safety handles the moderation pipeline.
 *   - "Hide apps from <author>" -> Apple 1.2 pillar #3 (block
 *     abusive users). Persists the author in `useHiddenAuthors`;
 *     the apps list filters them out before render so the user
 *     never sees content from that author again. Reversible from
 *     the `HelpAndSupportSheet` (Hidden authors section).
 *   - "View on Hugging Face" -> Apple 1.2 pillar #4-adjacent
 *     (transparency / source). Deeplinks to the Space card page
 *     where the user can read the README, follow the discussion
 *     threads, or report manually if they prefer.
 *
 * Pinned tiles (`AppPinnedTile`) deliberately do NOT render this
 * menu: pinned = the user *already* validated the app by pinning
 * it, the visual contract there is the iOS-Home-Screen-icon
 * pattern, and the same Report / Hide stay reachable from the
 * source compact tile in the rail / search results / category
 * focus.
 *
 * Action wiring
 * ─────────────
 * Both items deeplink out to `huggingface.co/spaces/<owner>/<slug>`
 * via the system browser:
 *
 *   - Report  -> `<spaceUrl>?report=true` opens HF's built-in
 *                report modal as soon as the page lands. HF Trust
 *                & Safety is the moderation backend.
 *   - View    -> `<spaceUrl>` lands on the Space card page (README,
 *                community tab, author profile).
 *
 * No backend of ours is in the loop; we don't store reports, don't
 * blocklist authors server-side from this menu. The HF platform
 * already has the policies + the team to handle that.
 *
 * Layer placement
 * ───────────────
 * Lives in `ui/panels/apps-list/` rather than `ui/widgets/` because
 * it's only consumed by surfaces inside the apps-list panel
 * (compact tile + iframe overlay). Per `AGENTS.md`: "Don't merge UI
 * primitives into ui/widgets/ if they're consumed by only one
 * panel. Keep it in the panel until a second consumer appears."
 */
import { useCallback, useState, type MouseEvent } from 'react';
import {
  Divider,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  type SxProps,
  type Theme,
} from '@mui/material';
import FlagOutlinedIcon from '@mui/icons-material/FlagOutlined';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';

import {
  buildSpaceCardUrl,
  buildSpaceReportUrl,
} from '@/features/apps/buildSpaceUrls';
import type { AppEntry } from '@/features/apps/types';
import { useHiddenAuthors } from '@/features/apps/useHiddenAuthors';
import { openExternalUrl } from '@/shared/tauri/openUrl';

interface AppActionsMenuProps {
  app: AppEntry;
  /**
   * Override the trigger button styling for tight surfaces (tile
   * headers, iframe top bar). Forwarded as `sx` on the
   * `IconButton`. Defaults to a subtle 28x28 button.
   */
  buttonSx?: SxProps<Theme>;
  /**
   * Optional aria-label override. Defaults to a contextual label
   * that includes the app name so the screen reader user can
   * disambiguate when multiple tiles are on screen.
   */
  ariaLabel?: string;
  /**
   * Optional callback fired AFTER the user successfully hid this
   * app's author. Hosts use it to dismiss themselves so the user
   * isn't left looking at a fullscreen iframe whose author is
   * now in the hidden list (the iframe overlay is the canonical
   * caller). When omitted, the menu just closes and the host
   * stays in place.
   */
  onAfterHideAuthor?: (author: string) => void;
}

export default function AppActionsMenu({
  app,
  buttonSx,
  ariaLabel,
  onAfterHideAuthor,
}: AppActionsMenuProps) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const open = anchorEl !== null;
  const { hide: hideAuthor } = useHiddenAuthors();
  // Hide is only offered when we have a real author to act on.
  // The catalog occasionally returns entries with `author: null`
  // (very rare; defensive path) and we'd rather not render a
  // disabled item than render a no-op. The menu still has Report
  // + View on HF in those edge cases.
  const canHideAuthor = typeof app.author === 'string' && app.author.length > 0;

  // The trigger sits inside surfaces (tiles, the iframe top bar)
  // that have their own click semantics: the tile body is
  // focus-visible and forwards Enter to onOpen, the iframe top bar
  // is the only chrome above a UGC iframe so we don't want a tap
  // on the kebab to bubble. `stopPropagation` on the trigger is
  // mandatory; we also stop propagation on each MenuItem so the
  // menu's backdrop dismissal doesn't replay onto the host card.
  const handleOpen = useCallback((e: MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    e.preventDefault();
    setAnchorEl(e.currentTarget);
  }, []);

  // MUI's `Menu.onClose` is called with `(event: {}, reason)` and
  // doesn't surface a real `SyntheticEvent`, so we keep the
  // dismissal handler arg-free. Bubbling is fine here because the
  // menu's modal backdrop already swallowed the click before this
  // fires.
  const handleClose = useCallback(() => {
    setAnchorEl(null);
  }, []);

  const handleReport = useCallback(
    async (e: MouseEvent<HTMLElement>) => {
      e.stopPropagation();
      handleClose();
      try {
        await openExternalUrl(buildSpaceReportUrl(app));
      } catch (err) {
        // Failing to open the system browser is non-fatal: the
        // user can still tap "View on Hugging Face" and find the
        // report button manually on the page. Log so we surface
        // the issue in dev without crashing UGC moderation.
        console.warn('[apps] report deeplink failed:', err);
      }
    },
    [app, handleClose],
  );

  const handleViewOnHf = useCallback(
    async (e: MouseEvent<HTMLElement>) => {
      e.stopPropagation();
      handleClose();
      try {
        await openExternalUrl(buildSpaceCardUrl(app));
      } catch (err) {
        console.warn('[apps] hf deeplink failed:', err);
      }
    },
    [app, handleClose],
  );

  const handleHideAuthor = useCallback(
    (e: MouseEvent<HTMLElement>) => {
      e.stopPropagation();
      handleClose();
      const author = app.author;
      if (typeof author !== 'string' || author.length === 0) return;
      hideAuthor(author);
      onAfterHideAuthor?.(author);
    },
    [app.author, handleClose, hideAuthor, onAfterHideAuthor],
  );

  return (
    <>
      <IconButton
        onClick={handleOpen}
        aria-label={ariaLabel ?? `Actions for ${app.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        size="small"
        sx={{
          p: 0.25,
          color: 'text.secondary',
          '&:hover': { color: 'text.primary' },
          ...buttonSx,
        }}
      >
        <MoreHorizIcon fontSize="small" />
      </IconButton>
      <Menu
        anchorEl={anchorEl}
        open={open}
        onClose={handleClose}
        // Match the visual weight of the rest of the catalog UI:
        // small font, tight spacing, single-line items so the
        // menu reads as a quick action sheet rather than a
        // settings panel.
        slotProps={{
          paper: {
            sx: {
              minWidth: 220,
              borderRadius: 1.5,
            },
          },
        }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <MenuItem onClick={handleReport}>
          <ListItemIcon>
            <FlagOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Report this app" />
        </MenuItem>
        {canHideAuthor && (
          <MenuItem onClick={handleHideAuthor}>
            <ListItemIcon>
              <VisibilityOffOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText
              primary={`Hide apps from ${app.author}`}
              secondary="You can undo this from Help & Support"
              secondaryTypographyProps={{ sx: { fontSize: '0.7rem' } }}
            />
          </MenuItem>
        )}
        <Divider />
        <MenuItem onClick={handleViewOnHf}>
          <ListItemIcon>
            <OpenInNewIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="View on Hugging Face" />
        </MenuItem>
      </Menu>
    </>
  );
}
