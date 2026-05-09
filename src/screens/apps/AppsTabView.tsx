/**
 * Apps tab body.
 *
 * Renders the list of Reachy Mini apps fetched from the public
 * catalog (`useApps()`). The catalog has ~200 entries today and
 * keeps growing, so the list is virtualized via
 * `@tanstack/react-virtual` to keep scroll performance flat
 * regardless of size: only the visible cards (+ a small overscan)
 * are mounted at any time.
 *
 * The tab itself is a "browse" surface - selecting an app triggers
 * the host's `onOpen` which mounts the iframe overlay.
 *
 * Layout
 * ──────
 * The outer `<Stack>` escapes its host column (`maxWidth: 420`
 * inside a `Stack px: 3`) via the `calc(50% - 50vw)` trick, so
 * three things span the entire viewport:
 *
 *   1. the sub-header's bottom divider (chrome-band feel),
 *   2. the scrollable area (native scrollbar lands flush with the
 *      phone edge),
 *   3. any future full-bleed UI we'd want here (search bar, …).
 *
 * Inside the bled-out column, every content row (header, hint,
 * scroll wrapper) re-applies the same `maxWidth: contentMaxWidth +
 * mx: 'auto'` constraint, so the title, the empty-state hints and
 * the cards are all aligned on one centred column with a 24px
 * gutter.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  Stack,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useVirtualizer } from '@tanstack/react-virtual';

import type { AppEntry } from '../../apps/types';
import { useApps } from '../../apps/useApps';
import { FONT_WEIGHT, LAYOUT, TYPO } from '../../styles/tokens';

import AppCard from './AppCard';

interface AppsTabViewProps {
  onOpen: (app: AppEntry) => void;
}

/**
 * Estimated row height fed to the virtualizer. Includes the card's
 * own height + the inter-card gap. Cards have a clamped 2-line
 * description and a fixed-height button, so the variance is small
 * enough that a constant estimate keeps scroll math correct without
 * needing dynamic measurement.
 *
 * Geometry: card content area = `ROW_HEIGHT_PX - ROW_GAP_PX`. Bump
 * `ROW_GAP_PX` for more breathing room between cards; bump
 * `ROW_HEIGHT_PX` in lockstep if you want to keep card size
 * unchanged when adjusting the gap.
 */
const ROW_HEIGHT_PX = 228;
const ROW_GAP_PX = 16;

/**
 * Shared `sx` that re-constrains a row to the centred content
 * column. Used by the sub-header, the empty-state hints and the
 * scroll wrapper so they all line up on one vertical axis.
 */
const COLUMN_SX = {
  width: '100%',
  maxWidth: LAYOUT.contentMaxWidth,
  mx: 'auto',
  px: 3,
} as const;

export default function AppsTabView({ onOpen }: AppsTabViewProps) {
  const { state, refresh } = useApps();
  const apps = 'apps' in state ? state.apps : [];
  const isLoading = state.kind === 'loading';
  const hasError = state.kind === 'error';

  // Scroll container is held in state (not just a ref) so the
  // scroll-direction effect below re-attaches its listener whenever
  // the container mounts/unmounts (different render branches:
  // empty / loading / error vs the actual list).
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  // The SubHeader is offset DIRECTLY by accumulated scroll delta so
  // it tracks the user's finger 1:1, like the iOS Safari address bar.
  // Pull down a tiny bit -> header reveals a tiny bit; flick up fast
  // -> header slams hidden. There is no snap, no boolean state, no
  // CSS transition - the marginTop is mutated straight on the DOM
  // node from the rAF callback to avoid triggering React renders
  // every frame and to avoid the transition fighting the scroll.
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [headerHeightPx, setHeaderHeightPx] = useState(77);

  // Measure the SubHeader's actual rendered height so the slide-up
  // clamp matches it exactly (token sizes, line-height changes
  // and font scaling all affect this without us hardcoding).
  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const update = () => setHeaderHeightPx(el.offsetHeight);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Wire the scroll-driven offset to the scroll container. Re-runs
  // when `scrollEl` mounts/unmounts (loading / error / list) and
  // when `headerHeightPx` changes (so the clamp stays correct after
  // a font-size change).
  useEffect(() => {
    if (!scrollEl) return;

    // Seed `lastScrollTop` from the live position so a non-zero
    // initial scroll (e.g. browser-restored on tab return) doesn't
    // count as a single huge delta on the first scroll event.
    let lastScrollTop = scrollEl.scrollTop;
    let currentOffset = 0;
    let ticking = false;

    const apply = (offset: number) => {
      const el = headerRef.current;
      if (!el) return;
      // `marginTop` (not `transform`) on purpose: we want the freed
      // space to actually be reclaimed by the scroll container so the
      // list expands behind the header as it slides under the top
      // bar's bottom edge. Transform would visually translate but
      // leave a stale gap.
      el.style.marginTop = offset === 0 ? '' : `${offset}px`;
    };

    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const current = Math.max(0, scrollEl.scrollTop);
        const delta = current - lastScrollTop;
        // Accumulate: scroll DOWN (delta > 0) pushes the header up,
        // scroll UP (delta < 0) pulls it back down. Clamped to
        // [-headerHeight, 0] so the header can never go past
        // "fully hidden" or "fully visible".
        currentOffset = clamp(currentOffset - delta, -headerHeightPx, 0);
        apply(currentOffset);
        lastScrollTop = current;
        ticking = false;
      });
    };

    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scrollEl.removeEventListener('scroll', onScroll);
      // Reset on cleanup so the next mount starts with a fully
      // visible header instead of inheriting stale inline style.
      apply(0);
    };
  }, [scrollEl, headerHeightPx]);

  // The virtualizer reads `getScrollElement` lazily on every
  // measurement pass, so it picks up the live `scrollEl` state
  // value without any extra wiring.
  const rowVirtualizer = useVirtualizer({
    count: apps.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => ROW_HEIGHT_PX,
    // ~3 rows of overscan keeps the user from ever seeing a blank
    // strip during fast scroll on mid-tier phones, while still
    // being small enough that the DOM stays bounded.
    overscan: 3,
  });

  return (
    <Stack
      sx={{
        flex: 1,
        minHeight: 0,
        // Full-bleed escape hatch. The host column caps at
        // `LAYOUT.contentMaxWidth` and centers via `mx: 'auto'`,
        // and the host `Stack` has `px: 3`. This pair pulls us
        // back out to the viewport edges so the sub-header divider
        // and the scrollbar both land flush with the phone border,
        // independent of any ancestor constraint. Each child below
        // re-applies the column constraints via `COLUMN_SX`.
        width: '100vw',
        mx: 'calc(50% - 50vw)',
        // Cancel the host column's `pt: 2` so the sub-header's
        // top divider sits flush against the screen's top bar
        // chrome (chrome-on-chrome continuity).
        mt: -2,
        // Clip everything to our own bounds. The screen's top bar
        // is a sibling that comes BEFORE us in document order, so
        // without clipping, our SubHeader's negative `marginTop`
        // (used to slide-hide on scroll-down) would paint *over*
        // the top bar - children of later siblings always win the
        // paint order when nothing has a stacking context. This
        // single `overflow: hidden` keeps the slide-up purely
        // local: the SubHeader visually disappears under the top
        // bar's bottom edge, exactly like the iOS Safari address
        // bar pattern, without having to tweak z-indices on the
        // top bar (which would ripple into the rest of the screen
        // chrome).
        overflow: 'hidden',
      }}
    >
      <SubHeader
        title="Apps"
        subtitle={
          hasError
            ? "Couldn't reach the Hub"
            : isLoading && apps.length === 0
              ? 'Fetching catalog…'
              : `${apps.length} app${apps.length === 1 ? '' : 's'} available`
        }
        action={
          <IconButton
            size="small"
            color="primary"
            aria-label="Refresh apps catalog"
            onClick={() => void refresh()}
            disabled={isLoading}
          >
            {isLoading ? (
              <CircularProgress size={16} color="primary" />
            ) : (
              <RefreshIcon fontSize="small" />
            )}
          </IconButton>
        }
        nativeRef={headerRef}
      />

      {state.kind === 'loading' && apps.length === 0 ? (
        <Box sx={{ ...COLUMN_SX, pt: 1.5 }}>
          <CenteredHint>
            <CircularProgress size={20} />
            <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary' }}>
              Asking the Hub for available apps…
            </Typography>
          </CenteredHint>
        </Box>
      ) : state.kind === 'error' && apps.length === 0 ? (
        <Box sx={{ ...COLUMN_SX, pt: 1.5 }}>
          <CenteredHint>
            <Typography sx={{ fontSize: TYPO.sm, fontWeight: FONT_WEIGHT.medium }}>
              Couldn't reach the Hub
            </Typography>
            <Typography
              sx={{ fontSize: TYPO.xs, color: 'text.secondary', textAlign: 'center' }}
            >
              {state.reason}
            </Typography>
            <Button
              size="small"
              variant="text"
              onClick={() => void refresh()}
              sx={{ textTransform: 'none' }}
            >
              Retry
            </Button>
          </CenteredHint>
        </Box>
      ) : apps.length === 0 ? (
        <Box sx={{ ...COLUMN_SX, pt: 1.5 }}>
          <CenteredHint>
            <Typography sx={{ fontSize: TYPO.sm, fontWeight: FONT_WEIGHT.medium }}>
              No apps yet
            </Typography>
            <Typography
              sx={{ fontSize: TYPO.xs, color: 'text.secondary', textAlign: 'center' }}
            >
              The Reachy Mini catalog is empty - check back soon.
            </Typography>
          </CenteredHint>
        </Box>
      ) : (
        <Box
          ref={(el: HTMLDivElement | null) => setScrollEl(el)}
          sx={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            // Pad the bottom so the last card isn't hugged by the
            // BottomNavigation - the host doesn't add bottom padding
            // to its main column to keep the bottom nav full-bleed.
            pb: 2,
            pt: 3,
          }}
        >
          <Box
            sx={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              // Re-apply the column constraint so the cards align
              // perfectly with the sub-header above. On phones the
              // viewport is narrower than `contentMaxWidth`, so
              // this collapses to full width and the per-item
              // padding below provides the 24px gutter.
              width: '100%',
              maxWidth: LAYOUT.contentMaxWidth,
              mx: 'auto',
              position: 'relative',
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const app = apps[virtualRow.index];
              if (!app) return null;
              return (
                <Box
                  key={app.id}
                  data-index={virtualRow.index}
                  sx={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  // Reserve the full estimated row height; the card
                  // itself fills minus the inter-row gap.
                  height: `${virtualRow.size}px`,
                  pb: `${ROW_GAP_PX}px`,
                    // 24px gutter on each side so the card borders
                    // never touch the column edge. Matches the
                    // sub-header's `px: 3`.
                    px: 3,
                  }}
                >
                  <AppCard app={app} onOpen={onOpen} />
                </Box>
              );
            })}
          </Box>
        </Box>
      )}
    </Stack>
  );
}

/**
 * Sub-header chrome for a tab body.
 *
 * Bottom divider spans the full viewport (the parent is bled out)
 * for the same chrome-band feel as the screen's top bar; the title
 * + subtitle + action sit on the same centred column as the body
 * content below.
 *
 * Scroll-driven slide
 * ───────────────────
 * The host (AppsTabView) drives this header's `marginTop` directly
 * on the DOM node via `nativeRef`, accumulating scroll delta from
 * the inner list so the header tracks the user's finger 1:1. There
 * is no `hidden` boolean and no CSS transition: an animation here
 * would fight the per-frame DOM mutation. The host clips the
 * sliding header to its own bounds (`overflow: hidden` on the
 * AppsTabView Stack) so the negative margin can never paint over
 * the screen's top bar.
 */
function SubHeader({
  title,
  subtitle,
  action,
  nativeRef,
}: {
  title: string;
  subtitle: string;
  action?: React.ReactNode;
  nativeRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <Box
      ref={nativeRef}
      sx={(theme) => ({
        flexShrink: 0,
        borderBottom: `1px solid ${theme.palette.divider}`,
        backgroundColor: theme.palette.background.default,
        // `marginTop` is mutated imperatively by the host's scroll
        // listener (see AppsTabView). We deliberately do NOT set a
        // CSS transition here - the per-frame DOM mutation would
        // race the transition's interpolation and produce a visible
        // lag behind the finger. Pure scrub instead.
      })}
    >
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ ...COLUMN_SX, py: 1.25, minHeight: 56 }}
      >
        <Stack sx={{ minWidth: 0, flex: 1 }}>
          <Typography
            sx={{
              fontSize: TYPO.lg,
              fontWeight: FONT_WEIGHT.semibold,
              color: 'text.primary',
            }}
          >
            {title}
          </Typography>
          <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary' }} noWrap>
            {subtitle}
          </Typography>
        </Stack>
        {action}
      </Stack>
    </Box>
  );
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function CenteredHint({ children }: { children: React.ReactNode }) {
  return (
    <Stack
      alignItems="center"
      spacing={1}
      sx={{
        py: 3,
        px: 2,
        borderRadius: 2,
        bgcolor: 'action.hover',
        color: 'text.secondary',
      }}
    >
      {children}
    </Stack>
  );
}
