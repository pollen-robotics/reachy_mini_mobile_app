/**
 * Compact rail tile.
 *
 * Marketplace-oriented card optimised for "pick an app and run it"
 * rather than a generic HF Store row. The layout puts the app's
 * identity (icon + name) front and centre, keeps trust signals
 * (author, official verified, likes) condensed on a single meta
 * line, and reserves the footer for the two real actions
 * (pin / launch).
 *
 * Visual contract:
 *
 *   ┌────────────────────────────────────┐
 *   │ ┌────┐  TelepresenceCtrl           │
 *   │ │ ⌬  │  by d10g ✓ · ♥ 205          │
 *   │ │    │  Stream the robot's camera  │
 *   │ └────┘  and drive it remotely…     │
 *   │                                    │
 *   │                          [★]  [▶]  │
 *   └────────────────────────────────────┘
 *
 * Layout rules
 * ────────────
 * - The icon sits in a 64×64 rounded plate with a subtle surface
 *   background, regardless of whether the glyph is a custom
 *   `icon.svg` or the emoji fallback - the plate keeps optical
 *   alignment uniform across apps that ship different glyph
 *   weights.
 * - The right column is `flex: 1 / minWidth: 0` so long names
 *   ellipsise instead of pushing the meta line and description
 *   off-screen. Description is clamped to 2 lines.
 * - The footer floats the action pair flush right. We dropped
 *   the date / clock icon and the avatar+username header rev:
 *   in a robot-launcher (≠ a generic dev store) they were
 *   noise more than signal.
 *
 * Tile width is viewport-relative (~"1.3 cards per slider") and
 * the height is content-driven within a min-height so short
 * descriptions still produce uniform tiles in a rail.
 *
 * Interactions
 * ────────────
 * - The card body itself is **not** a tap target. Both actions go
 *   through the footer icon buttons:
 *   - Star button toggles the pinned state. Outlined when not
 *     pinned, filled (primary) when pinned, with a pulse keyframe
 *     replayed on every toggle.
 *   - Play button opens the app via `setOpenedApp(app)`.
 * - The card stays focusable for keyboard users (focus ring on
 *   the card); pressing Enter targets the launch action.
 */
import { memo, useState } from 'react';
import { Box, Button, Typography, alpha } from '@mui/material';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import StarOutlineIcon from '@mui/icons-material/StarBorder';
import StarRoundedIcon from '@mui/icons-material/StarRounded';
import VerifiedIcon from '@mui/icons-material/Verified';

import type { AppEntry } from '@/features/apps/types';
import { useSpaceLike } from '@/features/apps/useSpaceLikes';
import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';
import AppActionsMenu from './AppActionsMenu';
import AppIcon from './AppIcon';
import LikeButton from './LikeButton';

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

function AppCompactTileImpl({
  app,
  isPinned,
  onOpen,
  onTogglePin,
  fullWidth = false,
}: AppCompactTileProps) {
  const StarIcon = isPinned ? StarRoundedIcon : StarOutlineIcon;
  const author = app.author;
  // Like state (HF Hub). When the user isn't signed in `canToggle`
  // is false and we degrade the heart to a static read-only badge -
  // hidden entirely when the catalog count is 0 too, so we don't
  // show a "0 ♡" badge with no affordance. The visual heart + burst
  // animation lives in `LikeButton` so the tile stays focused on
  // layout concerns.
  const like = useSpaceLike(app);
  const showLikeBadge = like.canToggle || like.displayedCount > 0;
  // The like badge has been promoted to the title row (right side
  // of the name) so the meta line only needs to consider author /
  // verified now.
  const hasMeta = !!author || app.isOfficial;

  // Click counter for the star pulse: each toggle bumps it,
  // which forces the inner star icon to remount via `key` and
  // replay the `star-pulse` keyframe. Cheaper than a CSS class
  // we'd have to remove + re-add to retrigger, and matches the
  // "continuity" timing target: the icon kicks instantly on
  // tap, the new pinned tile pops 80 ms later (see
  // `AppPinnedTile`'s pop-in keyframe).
  const [pulseKey, setPulseKey] = useState(0);

  const handleTogglePin = () => {
    setPulseKey(k => k + 1);
    onTogglePin(app);
  };

  return (
    <Box
      tabIndex={0}
      onKeyDown={e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onOpen(app);
        }
      }}
      sx={theme => ({
        flexShrink: 0,
        // Width branch: in `fullWidth` mode the tile is rendered
        // one-per-row inside a padded column (search results,
        // category focus). Otherwise it sits in a horizontal
        // rail and uses the "1 + 25 % peek" viewport-relative
        // formula:
        //
        //   1.25 × W + 24 = 100vw − 48  ⇒  W = (100vw − 72) / 1.25
        //
        // (24 px column padding + 24 px rail gap; see
        // `docs/APPS_TAB_REDESIGN.md` Section 4.3.) The peek used
        // to be 30 %, but the cards felt cramped once we promoted
        // the like badge into the title row, so we trade a bit of
        // "next card" preview for a roomier card.
        width: fullWidth ? '100%' : 'clamp(220px, calc((100vw - 72px) / 1.25), 340px)',
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
      {/* Top section: icon plate on the left, identity column on
          the right (name + meta line + description). The header
          row + inset divider from the pre-AppIcon layout was
          collapsed into this single row; the App-Store-1.2 UGC
          kebab (`AppActionsMenu`) lives in the meta line, see
          comment above the likes block. */}
      <Box
        sx={{
          display: 'flex',
          gap: 1.5,
          p: 1.5,
          flex: 1,
          minHeight: 0,
        }}
      >
        {/* Icon plate. 64×64 with the card's paper background and
            a light divider border so it reads as a sub-tile
            inside the card - keeps the glyph framed without
            adding visual weight, and works the same whether
            we render a custom SVG or the emoji fallback.
            `overflow: visible` so the custom icon can bleed a
            few pixels past the plate's border - it's sized
            larger than the plate on purpose (see below). */}
        <Box
          sx={theme => ({
            width: 64,
            height: 64,
            flexShrink: 0,
            borderRadius: `${RADIUS.md}px`,
            // Constant (near-)white illustration plate in BOTH modes:
            // app icons / logos assume a light backing, so a dark paper
            // plate in dark mode would muddy them. Slightly translucent
            // (0.8) so it's not a stark pure-white block.
            bgcolor: alpha(theme.palette.common.white, 0.15),
            border: `1px solid ${theme.palette.divider}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'visible',
          })}
        >
          {/* Emoji at 36px lives comfortably in the 64px plate
              with ~14px breathing room. A polished PNG icon
              renders at 70px (≈ +1/3 vs the previous 52), letting
              it overflow the plate by a few pixels on each side -
              that bleed sells the app's identity and gives the
              icon hero status without us having to enlarge the
              plate. SVG glyphs (typically edge-to-edge artwork
              with no internal padding) stay inside the plate at
              48px so they don't read as oversized next to a
              padded PNG sibling. */}
          <AppIcon app={app} size={36} imageSize={70} svgImageSize={48} />
        </Box>

        {/* Identity column. `minWidth: 0` lets ellipsis kick in
            when names/authors are too long for the rail width. */}
        <Box
          sx={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 0.25,
          }}
        >
          {/* Title row: name on the left (single-line ellipsis),
              like badge flush right. Vertically centred so the
              heart's optical mass sits on the title's mid-line. */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.75,
              minWidth: 0,
            }}
          >
            <Typography
              sx={{
                flex: 1,
                minWidth: 0,
                fontSize: TYPO.lg,
                fontWeight: FONT_WEIGHT.bold,
                color: 'text.primary',
                letterSpacing: '-0.3px',
                lineHeight: 1.2,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {app.name}
            </Typography>
            {showLikeBadge && (
              <LikeButton
                isLiked={like.isLiked}
                canToggle={like.canToggle}
                count={like.displayedCount}
                onToggle={like.toggle}
                ariaLabel={
                  like.canToggle
                    ? like.isLiked
                      ? `Unlike ${app.name}`
                      : `Like ${app.name}`
                    : `${like.displayedCount} likes`
                }
              />
            )}
          </Box>

          {/* Meta line: `by <author> ✓`. Author + verified badge
              live on their own row now that the like badge has
              moved up next to the title. */}
          {hasMeta && (
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
                minWidth: 0,
              }}
            >
              {author && (
                <Typography
                  component="span"
                  sx={{
                    fontSize: TYPO.xs,
                    fontWeight: FONT_WEIGHT.regular,
                    color: 'text.secondary',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                  }}
                >
                  by{' '}
                  <Box
                    component="span"
                    sx={{
                      fontWeight: FONT_WEIGHT.semibold,
                      color: 'text.primary',
                    }}
                  >
                    {author}
                  </Box>
                </Typography>
              )}
              {app.isOfficial && (
                <VerifiedIcon
                  sx={{
                    fontSize: TYPO.md,
                    color: 'primary.main',
                    flexShrink: 0,
                  }}
                  aria-label="Official"
                />
              )}
            </Box>
          )}

          {/* Description sits below the meta line with a small
              top margin. Clamped to 2 lines so tile heights stay
              predictable across cards with very long blurbs. */}
          <Typography
            sx={{
              mt: 0.5,
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
        </Box>
      </Box>

      {/* Footer: labelled action pair flush right. Outlined small
          buttons that match the desktop store's affordance, with
          the pinned-state cued by both a filled star and a very
          subtle primary tint on the background. */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: 0.75,
          px: 1.5,
          pb: 1.25,
        }}
      >
        {/* App-Store-1.2 UGC affordance: the "..." kebab opens the
            per-app actions menu (Report this app + Hide this
            author + View on Hugging Face). `mr: auto` pushes it to
            the left edge of the footer while keeping the Pin /
            Open buttons flush right, matching iOS App Store cards. */}
        <AppActionsMenu app={app} buttonSx={{ p: 0.25, mr: 'auto' }} />
        <Button
          variant="outlined"
          color="primary"
          size="small"
          aria-label={isPinned ? `Unpin ${app.name}` : `Pin ${app.name}`}
          startIcon={
            <StarIcon
              // Remount on every toggle to replay the keyframe
              // (assigning the same animation name doesn't re-fire
              // on its own).
              key={`star-${pulseKey}`}
              sx={{
                fontSize: TYPO.lg,
                // Kick the star with a quick scale spring on every
                // toggle. `pulseKey > 0` skips the very first
                // render so the tile doesn't pulse on initial
                // mount.
                animation:
                  pulseKey > 0 ? 'star-pulse 250ms cubic-bezier(0.34, 1.56, 0.64, 1)' : 'none',
                '@keyframes star-pulse': {
                  '0%': { transform: 'scale(1)' },
                  '40%': { transform: 'scale(1.35)' },
                  '100%': { transform: 'scale(1)' },
                },
              }}
            />
          }
          onClick={handleTogglePin}
          sx={theme => ({
            minWidth: 0,
            px: 1.25,
            py: 0.5,
            fontSize: TYPO.xs,
            fontWeight: FONT_WEIGHT.semibold,
            textTransform: 'none',
            borderRadius: `${RADIUS.md}px`,
            borderWidth: 1.5,
            // Pinned-state background: very subtle primary tint
            // (~6 % alpha). The filled star icon and the
            // "Pinned" label do most of the state-cue work; the
            // background is just there to whisper "this is the
            // on state" without shouting at the rest of the card.
            bgcolor: isPinned ? alpha(theme.palette.primary.main, 0.06) : 'transparent',
            '&:hover': {
              borderWidth: 1.5,
              bgcolor: isPinned ? alpha(theme.palette.primary.main, 0.1) : 'action.hover',
            },
            '&:active': {
              borderWidth: 1.5,
            },
            '& .MuiButton-startIcon': { mr: 0.5 },
          })}
        >
          {/* Inline-grid phantom: the longer label ("Pinned") is
              rendered in the same grid cell as the visible label
              but with `visibility: hidden`, so the button sizes
              itself to the longest state. The visible label then
              swaps freely without any reflow, which keeps the
              star pulse perfectly visible at the same
              x-position. */}
          <Box component="span" sx={{ display: 'inline-grid', placeItems: 'center' }}>
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
            <Box component="span" sx={{ gridColumn: 1, gridRow: 1, whiteSpace: 'nowrap' }}>
              {isPinned ? 'Pinned' : 'Pin'}
            </Box>
          </Box>
        </Button>
        <Button
          variant="outlined"
          color="primary"
          size="small"
          aria-label={`Try ${app.name}`}
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
          Try
        </Button>
      </Box>
    </Box>
  );
}

export default memo(AppCompactTileImpl);
