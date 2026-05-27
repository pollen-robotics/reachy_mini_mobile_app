/**
 * Conversation language picker.
 *
 *   ┌───┐
 *   │🇬🇧│   <- compact tap target (anchor)
 *   └───┘
 *      ↓ on tap
 *   ┌──────────────┐
 *   │ ✓ 🇬🇧 English │
 *   │   🇫🇷 Français│
 *   │   🇪🇸 Español │
 *   │   …          │
 *   └──────────────┘
 *
 * Pure UI consumer of the `conversation-language` store. Tapping
 * the anchor opens a MUI Menu listing the 7 supported languages
 * (flag + endonym + check on the active one). Selecting one
 * commits to the store, which:
 *
 *   1. persists the choice in localStorage (handled by the store),
 *   2. notifies the ConversationPanel restart effect so the live
 *      conversation reconnects with the new language fragment
 *      injected into the system prompt.
 *
 * Disabled state
 * ──────────────
 * The host (ConversationPanel) can disable the picker while a
 * mid-call switch would be confusing (e.g. error state). We don't
 * disable it during a live conversation: changing language is one
 * of the few "intentional restart" affordances we expose, and the
 * UX of "ask the bot in voice to change language" complements but
 * doesn't replace the explicit picker tap.
 *
 * Accessibility
 * ─────────────
 *   - The anchor is a proper `<IconButton>` with an aria label
 *     spelling out the current language + the action ("Change
 *     language - currently English").
 *   - Each menu item is a `<MenuItem>` with the language's English
 *     name as accessible text (the endonym is the visible label;
 *     screen readers read it natively too, but the aria-label
 *     spells it in English for robustness).
 *   - The active language carries `aria-current="true"` on its
 *     menu item.
 */
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import { IconButton, ListItemIcon, ListItemText, Menu, MenuItem, Typography } from '@mui/material';
import { useCallback, useState, type MouseEvent as ReactMouseEvent } from 'react';

import {
  LANGUAGES,
  setActiveLanguageId,
  useActiveLanguageMeta,
  type LanguageId,
} from '@/features/conversation-language';
import { TYPO } from '@/ui/design/tokens';

interface LanguageFlagPickerProps {
  /** Disable the anchor + grey out the flag. Used when the orb is
   *  in an error state and a restart would compound user
   *  confusion. */
  disabled?: boolean;
}

/** Fixed-size square anchor. Sits just slightly larger than the
 *  audio control icon buttons (28×28) so the flag reads as its
 *  own "preference" affordance while still feeling part of the
 *  same bottom strip. The vertical divider next to it in
 *  `ConversationPanel` carries the "this is a separate group"
 *  signal so we don't need a permanent border on the anchor. */
const ANCHOR_SIZE = 32;
/** Flag emoji size. Tuned against the 32px square so the glyph
 *  fills most of the tap target without clipping on iOS Safari
 *  (which renders flag emojis slightly taller than their
 *  font-size). */
const FLAG_FONT_SIZE = '1.25rem';

export function LanguageFlagPicker({ disabled = false }: LanguageFlagPickerProps) {
  const active = useActiveLanguageMeta();
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const open = anchorEl !== null;

  const handleOpen = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  }, []);
  const handleClose = useCallback(() => {
    setAnchorEl(null);
  }, []);

  const handlePick = useCallback((id: LanguageId) => {
    setActiveLanguageId(id);
    setAnchorEl(null);
  }, []);

  return (
    <>
      <IconButton
        size="small"
        disabled={disabled}
        onClick={handleOpen}
        aria-haspopup="true"
        aria-expanded={open ? 'true' : undefined}
        aria-controls={open ? 'language-picker-menu' : undefined}
        aria-label={`Change language - currently ${active.nameEnglish}`}
        sx={{
          width: ANCHOR_SIZE,
          height: ANCHOR_SIZE,
          // Flag emojis sit slightly above their baseline; pinning
          // line-height to 1 centers the visible glyph in the
          // square.
          lineHeight: 1,
          // No permanent border: the vertical divider that lives
          // beside the picker in the ConversationPanel strip
          // already carries the "separate group" signal, and a
          // second outline here piles affordances. We keep a soft
          // hover bg so the tap target stays discoverable, and
          // rely on MUI's `.Mui-focusVisible` ring for keyboard
          // focus.
          borderRadius: 1.25,
          transition: 'background-color 120ms ease',
          '&:hover': {
            bgcolor: 'action.hover',
          },
          '&.Mui-disabled': {
            opacity: 0.45,
          },
        }}
      >
        <span style={{ fontSize: FLAG_FONT_SIZE, lineHeight: 1 }}>{active.flag}</span>
      </IconButton>
      <Menu
        id="language-picker-menu"
        anchorEl={anchorEl}
        open={open}
        onClose={handleClose}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        slotProps={{
          paper: {
            elevation: 6,
            sx: {
              mt: -1,
              minWidth: 180,
              // Slightly tighter row density than MUI's default -
              // 7 entries should fit on a phone screen without the
              // menu scrolling.
              '& .MuiMenuItem-root': {
                py: 0.75,
                gap: 1,
              },
            },
          },

          list: { dense: true, 'aria-label': 'Conversation language' },
        }}
      >
        {LANGUAGES.map(lang => {
          const isActive = lang.id === active.id;
          return (
            <MenuItem
              key={lang.id}
              onClick={() => handlePick(lang.id)}
              aria-current={isActive ? 'true' : undefined}
              aria-label={lang.nameEnglish}
              selected={isActive}
            >
              {/* Reuse the standard MUI ListItemIcon slot so the
                  flag column lines up across rows regardless of
                  emoji width. The check sits in the same slot on
                  the active row - we swap the icon, not the
                  layout. */}
              <ListItemIcon sx={{ minWidth: '32px !important' }}>
                {isActive ? (
                  <CheckRoundedIcon sx={{ fontSize: TYPO.lg }} />
                ) : (
                  <span style={{ fontSize: '1.1rem', lineHeight: 1 }}>{lang.flag}</span>
                )}
              </ListItemIcon>
              <ListItemText
                primary={
                  <Typography sx={{ fontSize: TYPO.body, fontWeight: isActive ? 600 : 400 }}>
                    {lang.nameNative}
                  </Typography>
                }
              />
            </MenuItem>
          );
        })}
      </Menu>
    </>
  );
}
