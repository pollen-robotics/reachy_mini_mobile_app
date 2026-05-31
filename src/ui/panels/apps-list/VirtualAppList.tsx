/**
 * Windowed vertical list of `AppCompactTile`s.
 *
 * Used by the Apps tab's two flat-list modes - search results and
 * category "See all" focus - where the list can run to the full
 * catalog (200-300 rows). Rendering them all mounts hundreds of tiles,
 * each with its own TanStack like-observer + icon load; this component
 * keeps only the visible window (plus a small overscan) in the DOM via
 * `@tanstack/react-virtual`.
 *
 * Scroll model
 * ────────────
 * The list does NOT own a scroll container of its own: it lives inside
 * the Apps tab's single scrollable body, below other panels (the
 * pinned dock + sticky search bar in search mode, the back-header in
 * focus mode). We therefore drive the virtualiser off that shared
 * scroll element (`scrollRef`) and offset the window by `scrollMargin`
 * - the distance from the top of the scroll content down to where this
 * list begins. That offset is measured from the DOM (robust to
 * whatever sits above) and recomputed on resize / mode change.
 *
 * Row heights are content-driven (a tile is 1 or 2 description lines),
 * so we let the virtualiser measure each mounted row (`measureElement`)
 * rather than assume a fixed height, and use its native `gap` option
 * to reproduce the list's vertical rhythm.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Box } from '@mui/material';
import { useVirtualizer } from '@tanstack/react-virtual';

import type { AppEntry } from '@/features/apps/types';

import AppCompactTile from './AppCompactTile';
import { COLUMN_SX, LIST_ROW_GAP_PX } from './layout';

interface VirtualAppListProps {
  apps: AppEntry[];
  /** The Apps tab's scrollable body. The window is computed against it. */
  scrollRef: RefObject<HTMLElement | null>;
  pinnedSet: ReadonlySet<string>;
  onOpen: (app: AppEntry) => void;
  onTogglePin: (app: AppEntry) => void;
}

/**
 * First-paint row-height guess, refined per row by `measureElement`.
 * A two-line tile is ~150 px; a close estimate just keeps the initial
 * scrollbar length sensible before measurement kicks in.
 */
const ESTIMATED_ROW_PX = 150;

export default function VirtualAppList({
  apps,
  scrollRef,
  pinnedSet,
  onOpen,
  onTogglePin,
}: VirtualAppListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  // Distance from the top of the scroll content to the start of this
  // list. Measured from the DOM so it stays correct no matter what
  // panels render above us, and recomputed when the scroller resizes
  // or the list identity changes (search ⇆ focus, query change).
  useLayoutEffect(() => {
    const listEl = listRef.current;
    const scroller = scrollRef.current;
    if (!listEl || !scroller) return;

    const measure = () => {
      const offset =
        listEl.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop;
      setScrollMargin(prev => (Math.abs(prev - offset) > 0.5 ? offset : prev));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    return () => ro.disconnect();
  }, [scrollRef, apps.length]);

  const virtualizer = useVirtualizer({
    count: apps.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_PX,
    overscan: 6,
    gap: LIST_ROW_GAP_PX,
    scrollMargin,
  });

  return (
    <Box sx={COLUMN_SX}>
      <Box
        ref={listRef}
        sx={{ position: 'relative', width: '100%', height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map(item => {
          const app = apps[item.index];
          if (!app) return null;
          return (
            <Box
              key={app.id}
              data-index={item.index}
              ref={virtualizer.measureElement}
              sx={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${item.start - scrollMargin}px)`,
              }}
            >
              <AppCompactTile
                app={app}
                isPinned={pinnedSet.has(app.id)}
                onOpen={onOpen}
                onTogglePin={onTogglePin}
                fullWidth
              />
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
