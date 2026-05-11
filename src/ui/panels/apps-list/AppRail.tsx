/**
 * Horizontal rail.
 *
 * A category-scoped horizontal scroll container with a header and
 * an optional "See ›" affordance. Renders one `AppCompactTile` per
 * app in the bucket. The rail is a pure layout primitive: the
 * decision to show or hide it (empty bucket) lives in the consumer
 * (`AppsTabView`).
 *
 * Visual contract (see `docs/APPS_TAB_REDESIGN.md`, Section 4.1):
 *
 *   Voice & Chat                              See all  ›
 *   6 apps
 *   ┌──────────────┐  ┌──────────────┐  ┌──────────
 *   │  🎙️         │  │  🤖          │  │  🤖
 *   │ Conv         │  │ Perplexity   │  │ Claude
 *   │ ...          │  │ ...          │  │ ...
 *   └──────────────┘  └──────────────┘  └──────────
 *
 * Header layout (sentence-case heading + sub-line count + plain
 * "See all" link with chevron) replaces the earlier
 * uppercase-letter-spaced + underlined-link treatment, which
 * had become noisy through successive iterations.
 *
 * Native scroll, scroll-snap on tile boundaries so a flick lands
 * cleanly on the next tile rather than mid-card.
 */
import type { ReactNode } from 'react';
import { Box, ButtonBase, Stack, Typography } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';

import { FONT_WEIGHT, TYPO } from '@/ui/design/tokens';

interface AppRailProps {
  /** Display label, rendered as a sentence-case heading. */
  label: string;
  /**
   * Optional count appended to the header (`VOICE & CHAT · 6`).
   * Used by the consumer to surface bucket size at a glance. Skip
   * for surfaces where the count is meaningless (e.g. the
   * "Pinned" rail, where the user already manages the list).
   */
  count?: number;
  /** Optional handler for the trailing "See ›" tap. */
  onSeeAll?: () => void;
  /**
   * Inline content, typically a sequence of `AppCompactTile`
   * components but the rail is content-agnostic so the consumer
   * can drop any element in (e.g. an "empty state" hint).
   */
  children: ReactNode;
  /**
   * Horizontal padding applied to the inner scroll track. Matches
   * the host column's `px: 3` so tiles align with the rail header
   * + with neighbouring text columns. Bumped on the right so the
   * last tile gets a peek-of-the-edge gutter instead of bumping
   * into the viewport.
   */
  paddingX?: number;
}

export default function AppRail({
  label,
  count,
  onSeeAll,
  children,
  paddingX = 3,
}: AppRailProps) {
  return (
    <Box>
      <Box
        sx={{
          px: paddingX,
          mb: 1.75,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1.5,
        }}
      >
        {/* Title cluster: sentence-case heading on top, optional
            small "{count} apps" sub-line below. The earlier
            uppercase-letter-spaced treatment had become noisy
            once it was sharing space with the underlined "See
            all" link; pulling the count down to a sub-line
            gives the title room to breathe and aligns the rail
            header with the App Store / iOS convention. */}
        <Stack sx={{ minWidth: 0, flex: 1 }}>
          <Typography
            sx={{
              fontSize: TYPO.lg,
              fontWeight: FONT_WEIGHT.semibold,
              color: 'text.primary',
              letterSpacing: '-0.2px',
              lineHeight: 1.2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {label}
          </Typography>
          {typeof count === 'number' && (
            <Typography
              sx={{
                fontSize: TYPO.xs,
                color: 'text.secondary',
                lineHeight: 1.2,
                mt: 0.25,
              }}
            >
              {count} app{count === 1 ? '' : 's'}
            </Typography>
          )}
        </Stack>
        {onSeeAll && (
          <ButtonBase
            onClick={onSeeAll}
            disableRipple
            sx={{
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 0.25,
              fontSize: TYPO.sm,
              fontWeight: FONT_WEIGHT.medium,
              color: 'primary.main',
              // No underline, no uppercase: a quiet sentence-case
              // text link with a trailing chevron, the way the
              // rest of the modern iOS / App Store surfaces
              // render their "See all" affordance. The bumped
              // `:hover` opacity is the only state cue the user
              // gets on touch surfaces - rippleless to keep it
              // calm.
              '&:hover': { opacity: 0.7 },
              '&:active': { opacity: 0.6 },
            }}
          >
            See all
            <ChevronRightIcon sx={{ fontSize: TYPO.lg, ml: 0.25 }} />
          </ButtonBase>
        )}
      </Box>

      <Box
        sx={(theme) => ({
          display: 'flex',
          gap: 3,
          overflowX: 'auto',
          overflowY: 'hidden',
          // Hide native scrollbar - the tile peek + the chevron in
          // the header are enough to advertise scrollability.
          scrollbarWidth: 'none',
          '::-webkit-scrollbar': { display: 'none' },
          // Snap tile-by-tile so a flick lands cleanly on a
          // boundary rather than mid-card.
          scrollSnapType: 'x proximity',
          // Offset the snap point so the first tile keeps the
          // `pl` gutter visible at scrollLeft=0. Without this,
          // `scroll-snap-align: start` aligns the first tile
          // flush against the scrollport edge and "absorbs" the
          // padding, making the tile look stuck to the screen
          // border. `scroll-padding-inline-end` pairs symmetry
          // for the last tile.
          scrollPaddingInlineStart: theme.spacing(paddingX),
          scrollPaddingInlineEnd: theme.spacing(paddingX),
          '& > *': {
            scrollSnapAlign: 'start',
          },
          // Outer paddings give the first tile a left gutter and
          // the last tile a right gutter without resorting to
          // sentinel spacers.
          pl: paddingX,
          pr: paddingX,
        })}
      >
        {children}
      </Box>
    </Box>
  );
}
