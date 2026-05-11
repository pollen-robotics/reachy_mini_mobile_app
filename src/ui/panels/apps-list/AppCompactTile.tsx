/**
 * Compact rail tile.
 *
 * Visually mirrors the desktop store card: a header with the
 * author avatar + likes, an inset divider, then a body with the
 * app name, the author-chosen emoji on the right, a 2-line
 * description, and a footer carrying the last-modified date on
 * the left and the action buttons (pin + launch) on the right.
 *
 * Visual contract (see `docs/APPS_TAB_REDESIGN.md`, Section 4.3):
 *
 *   ┌──────────────────────────┐
 *   │ [D] d10g            ❤ 205│   header: avatar + author + likes
 *   ├──────────────────────────┤   divider
 *   │ f1commentator        🏎  │   name (bold) + emoji right
 *   │ An interactive F1 race   │
 *   │ commentary system for…   │   description (2 lines clamp)
 *   │                          │
 *   │ ⏰ Feb 15        [★] [▶] │   date · pin · launch
 *   └──────────────────────────┘
 *
 * Tile width is viewport-relative (~"1.3 cards per slider") and
 * the height is content-driven within a min-height so short
 * descriptions still produce uniform tiles in a rail.
 *
 * Interactions:
 *
 * - The card body itself is **not** a tap target. All actions go
 *   through the two icon buttons in the footer:
 *   - Star button toggles the pinned state. Outlined when not
 *     pinned, filled in primary when pinned.
 *   - Play button opens the app via the same `setOpenedApp(app)`
 *     path the legacy "tap anywhere" used to trigger.
 * - The card stays focusable for keyboard users (focus ring on
 *   the card); pressing Enter targets the launch action.
 */
import { memo, useState } from 'react';
import {
  Avatar,
  Box,
  Button,
  Typography,
  alpha,
} from '@mui/material';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import FavoriteBorderIcon from '@mui/icons-material/FavoriteBorder';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import StarOutlineIcon from '@mui/icons-material/StarOutline';
import StarRoundedIcon from '@mui/icons-material/StarRounded';
import VerifiedIcon from '@mui/icons-material/Verified';

import { readAppEmoji } from '@/features/apps/emoji';
import type { AppEntry } from '@/features/apps/types';
import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';

interface AppCompactTileProps {
  app: AppEntry;
  isPinned: boolean;
  onOpen: (app: AppEntry) => void;
  onTogglePin: (app: AppEntry) => void;
  /**
   * When true, the tile spans `width: 100%` of its parent
   * (used in search results and category-focus mode where the
   * tile is a list-row, one per line). When false / unset, it
   * falls back to the rail's viewport-relative `clamp` formula
   * that produces "1 + 30 % peek" framing inside a horizontal
   * scroll track.
   */
  fullWidth?: boolean;
}

/**
 * Cardinality-stable accessor for `lastModified` that lives in
 * `extra` on a normalized catalog entry. A malformed payload
 * just renders the empty fallback instead of blowing up the row.
 * Returns a short "Mon D" format (no year) to fit the tile's
 * cramped footer while still anchoring the user in time.
 */
function readLastModified(app: AppEntry): string | null {
  const raw =
    (app.extra?.lastModified as string | number | undefined) ||
    (app.extra?.createdAt as string | number | undefined) ||
    null;
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function AppCompactTileImpl({
  app,
  isPinned,
  onOpen,
  onTogglePin,
  fullWidth = false,
}: AppCompactTileProps) {
  const emoji = readAppEmoji(app);
  const StarIcon = isPinned ? StarRoundedIcon : StarOutlineIcon;
  const formattedDate = readLastModified(app);
  const author = app.author;

  // Click counter for the star pulse: each toggle bumps it,
  // which forces the inner star icon to remount via `key` and
  // replay the `star-pulse` keyframe. Cheaper than a CSS class
  // we'd have to remove + re-add to retrigger, and matches the
  // "continuity" timing target: the icon kicks instantly on
  // tap, the new pinned tile pops 80 ms later (see
  // `AppPinnedTile`'s pop-in keyframe).
  const [pulseKey, setPulseKey] = useState(0);

  const handleTogglePin = () => {
    setPulseKey((k) => k + 1);
    onTogglePin(app);
  };

  return (
    <Box
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onOpen(app);
        }
      }}
      sx={(theme) => ({
        flexShrink: 0,
        // Width branch: in `fullWidth` mode the tile is rendered
        // one-per-row inside a padded column (search results,
        // category focus). Otherwise it sits in a horizontal
        // rail and uses the "1 + 30 % peek" viewport-relative
        // formula:
        //
        //   1.3 × W + 24 = 100vw − 48  ⇒  W = (100vw − 72) / 1.3
        //
        // (24 px column padding + 24 px rail gap; see
        // `docs/APPS_TAB_REDESIGN.md` Section 4.3.)
        width: fullWidth
          ? '100%'
          : 'clamp(208px, calc((100vw - 72px) / 1.3), 320px)',
        // Height is content-driven in both modes so a tile with
        // a 1-line description doesn't pad itself out to match a
        // 2-line tile - the cards then read with the same
        // breathing room whether they're in a rail or stacked
        // one-per-row in a search/focus list.
        height: 'auto',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: `${RADIUS.lg}px`,
        bgcolor: 'background.paper',
        border: `1px solid ${theme.palette.divider}`,
        overflow: 'hidden',
        userSelect: 'none',
        WebkitTapHighlightColor: 'transparent',
        position: 'relative',
        '&:focus-visible': {
          outline: `2px solid ${theme.palette.primary.main}`,
          outlineOffset: 2,
        },
      })}
    >
      {/* Header: author + likes. Avatar is the author's initial,
          monospaced username next to it, and the heart-count
          flush right. Mirrors the desktop store layout. */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 1,
          px: 1.5,
          pt: 1.25,
          pb: 0,
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            minWidth: 0,
            flex: 1,
          }}
        >
          {author && (
            <>
              <Avatar
                sx={(theme) => ({
                  width: 22,
                  height: 22,
                  bgcolor: app.isOfficial
                    ? 'primary.light'
                    : theme.palette.action.selected,
                  fontSize: TYPO.tiny,
                  fontWeight: FONT_WEIGHT.semibold,
                  color: app.isOfficial
                    ? theme.palette.primary.contrastText
                    : 'text.primary',
                  flexShrink: 0,
                })}
              >
                {author.charAt(0).toUpperCase()}
              </Avatar>
              <Typography
                sx={{
                  fontSize: TYPO.xs,
                  fontWeight: FONT_WEIGHT.medium,
                  color: 'text.secondary',
                  fontFamily: 'monospace',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  minWidth: 0,
                }}
              >
                {author}
              </Typography>
              {app.isOfficial && (
                <VerifiedIcon
                  sx={{ fontSize: TYPO.sm, color: 'primary.main', flexShrink: 0 }}
                  aria-label="Official"
                />
              )}
            </>
          )}
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}>
          <FavoriteBorderIcon sx={{ fontSize: TYPO.lg, color: 'text.secondary' }} />
          <Typography
            sx={{
              fontSize: TYPO.sm,
              fontWeight: FONT_WEIGHT.semibold,
              color: 'text.secondary',
              lineHeight: 1,
            }}
          >
            {app.likes || 0}
          </Typography>
        </Box>
      </Box>

      {/* Inset divider. Padded to match the desktop store's
          `px: 2` rhythm so the line is centered between the
          header and body content. */}
      <Box sx={{ px: 1.5, pt: 1, pb: 0 }}>
        <Box
          sx={(theme) => ({
            borderBottom: `1px solid ${theme.palette.divider}`,
          })}
        />
      </Box>

      {/* Body: name + emoji on top row, then description, then
          footer with date and the two action buttons. */}
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          px: 1.5,
          py: 1.5,
          flex: 1,
          minHeight: 0,
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 1,
          }}
        >
          <Typography
            sx={{
              fontSize: TYPO.lg,
              fontWeight: FONT_WEIGHT.bold,
              color: 'text.primary',
              letterSpacing: '-0.3px',
              lineHeight: 1.2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
              minWidth: 0,
            }}
          >
            {app.name}
          </Typography>
          <Typography
            component="span"
            aria-hidden
            sx={{
              fontSize: 24,
              lineHeight: 1,
              flexShrink: 0,
              mt: 0.25,
            }}
          >
            {emoji}
          </Typography>
        </Box>

        <Typography
          sx={{
            fontSize: TYPO.sm,
            color: 'text.secondary',
            lineHeight: 1.45,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {app.description || '\u00a0'}
        </Typography>

        {/* Footer pinned to the bottom via `mt: auto` so tiles
            with a 1-line description still align their actions
            with multi-line tiles in the same rail. Single row:
            date on the left (shrinks with ellipsis if the tile
            is narrow), labelled buttons flush right. */}
        <Box
          sx={{
            mt: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            pt: 0.5,
          }}
        >
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              minWidth: 0,
              flex: 1,
            }}
          >
            {formattedDate && (
              <>
                <AccessTimeIcon
                  sx={{ fontSize: TYPO.sm, color: 'text.secondary', flexShrink: 0 }}
                />
                <Typography
                  sx={{
                    fontSize: TYPO.tiny,
                    fontWeight: FONT_WEIGHT.medium,
                    color: 'text.secondary',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {formattedDate}
                </Typography>
              </>
            )}
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexShrink: 0 }}>
            <Button
              variant="outlined"
              color="primary"
              size="small"
              aria-label={isPinned ? `Unpin ${app.name}` : `Pin ${app.name}`}
              startIcon={
                <StarIcon
                  // Remount on every toggle to replay the keyframe
                  // (assigning the same animation name doesn't
                  // re-fire on its own).
                  key={`star-${pulseKey}`}
                  sx={{
                    fontSize: TYPO.lg,
                    // Kick the star with a quick scale spring on
                    // every toggle. `pulseKey > 0` skips the very
                    // first render so the tile doesn't pulse on
                    // initial mount.
                    animation:
                      pulseKey > 0
                        ? 'star-pulse 250ms cubic-bezier(0.34, 1.56, 0.64, 1)'
                        : 'none',
                    '@keyframes star-pulse': {
                      '0%': { transform: 'scale(1)' },
                      '40%': { transform: 'scale(1.35)' },
                      '100%': { transform: 'scale(1)' },
                    },
                  }}
                />
              }
              onClick={handleTogglePin}
              sx={(theme) => ({
                minWidth: 0,
                px: 1.25,
                py: 0.5,
                fontSize: TYPO.xs,
                fontWeight: FONT_WEIGHT.semibold,
                textTransform: 'none',
                borderRadius: `${RADIUS.md}px`,
                borderWidth: 1.5,
                // Pinned-state background: very subtle primary
                // tint (~6 % alpha) instead of the heavier
                // `action.selected` grey. The filled star icon
                // and the "Pinned" label do most of the
                // state-cue work; the background is just there
                // to whisper "this is the on state" without
                // shouting at the rest of the card.
                bgcolor: isPinned
                  ? alpha(theme.palette.primary.main, 0.06)
                  : 'transparent',
                '&:hover': {
                  borderWidth: 1.5,
                  bgcolor: isPinned
                    ? alpha(theme.palette.primary.main, 0.1)
                    : 'action.hover',
                },
                '&:active': {
                  borderWidth: 1.5,
                },
                '& .MuiButton-startIcon': { mr: 0.5 },
              })}
            >
              {/* Inline-grid phantom: the longer label ("Pinned")
                  is rendered in the same grid cell as the visible
                  label but with `visibility: hidden`, so the
                  button sizes itself to the longest state. The
                  visible label then swaps freely without any
                  reflow, which keeps the star pulse perfectly
                  visible at the same x-position. */}
              <Box
                component="span"
                sx={{ display: 'inline-grid', placeItems: 'center' }}
              >
                <Box
                  component="span"
                  aria-hidden
                  sx={{
                    gridColumn: 1,
                    gridRow: 1,
                    visibility: 'hidden',
                    whiteSpace: 'nowrap',
                  }}
                >
                  Pinned
                </Box>
                <Box
                  component="span"
                  sx={{ gridColumn: 1, gridRow: 1, whiteSpace: 'nowrap' }}
                >
                  {isPinned ? 'Pinned' : 'Pin'}
                </Box>
              </Box>
            </Button>
            <Button
              variant="outlined"
              color="primary"
              size="small"
              aria-label={`Launch ${app.name}`}
              startIcon={<PlayArrowOutlinedIcon sx={{ fontSize: TYPO.lg }} />}
              onClick={() => onOpen(app)}
              sx={{
                minWidth: 0,
                px: 1.25,
                py: 0.5,
                fontSize: TYPO.xs,
                fontWeight: FONT_WEIGHT.semibold,
                textTransform: 'none',
                borderRadius: `${RADIUS.md}px`,
                borderWidth: 1.5,
                bgcolor: 'transparent',
                '&:hover': {
                  borderWidth: 1.5,
                  bgcolor: 'action.hover',
                },
                '&:active': {
                  borderWidth: 1.5,
                },
                '& .MuiButton-startIcon': { mr: 0.5 },
              }}
            >
              Launch
            </Button>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

export default memo(AppCompactTileImpl);
