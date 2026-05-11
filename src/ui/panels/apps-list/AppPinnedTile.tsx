/**
 * Pinned-grid tile, "icon dock" variant.
 *
 * Pure emoji-square + name-below pattern, modelled after the iOS
 * App Library / Home Screen icons. The square is the only
 * visual surface; the name sits OUTSIDE the square in the smaller
 * caption-style line so the glyph reads as the icon and the name
 * as its label, the same way an iOS icon does.
 *
 * Visual contract (see `docs/APPS_TAB_REDESIGN.md`, Section 4.5):
 *
 *   ┌────────┐
 *   │        │
 *   │   🎵   │   square: aspectRatio 1/1, emoji ~44 px centred
 *   │        │
 *   └────────┘
 *      DJ        name (1 line, ellipsis), 11 px, secondary
 *
 * The square is fluid (`width: 100%`, `aspectRatio: 1 / 1`) so it
 * sizes to the parent grid cell. Three-column grid in the host
 * (`AppsTabView`) means each cell is ~96 px wide on a 360 px
 * viewport, producing a 96 x 96 square + the caption.
 *
 * Tap = open the app. Long-press (≥ 500 ms) = unpin directly, no
 * confirmation sheet (this is the only V1 long-press in the apps
 * tab; pinning happens via the star toggles on compact tiles and
 * list rows).
 */
import { memo, useEffect, useRef } from 'react';
import { Box, Typography } from '@mui/material';

import { readAppEmoji } from '@/features/apps/emoji';
import type { AppEntry } from '@/features/apps/types';
import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';

interface AppPinnedTileProps {
  app: AppEntry;
  /**
   * `true` when this tile's `id` was added to the pinned set in
   * the current render pass (and thus arrives "live" from the
   * user's pin gesture). Drives the pop-in keyframe; when
   * `false`, the tile mounts in its final state with no entry
   * animation. The host (`PinnedGrid`) computes this by diffing
   * the current ids against the set of ids it rendered in the
   * previous pass, so we don't get a stagger of pop-ins on
   * initial Apps-tab load with pre-existing pins.
   */
  isNew?: boolean;
  onOpen: (app: AppEntry) => void;
  /**
   * Fired after a 500 ms press without a release. The host
   * unpins the app immediately, no confirmation sheet. The
   * component cancels the timer on early release / pointer
   * cancel and suppresses the click that would otherwise
   * follow the long-press.
   */
  onLongPress?: (app: AppEntry) => void;
}

const LONG_PRESS_MS = 500;

function AppPinnedTileImpl({
  app,
  isNew = false,
  onOpen,
  onLongPress,
}: AppPinnedTileProps) {
  const emoji = readAppEmoji(app);

  // Long-press state lives in refs so it persists across renders
  // (a plain `let` at the component scope would reset and the
  // long-press would never fire).
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPressRef = useRef(false);

  useEffect(() => {
    return () => {
      if (pressTimerRef.current !== null) {
        clearTimeout(pressTimerRef.current);
        pressTimerRef.current = null;
      }
    };
  }, []);

  const clearTimer = () => {
    if (pressTimerRef.current !== null) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  };

  const handlePointerDown = () => {
    didLongPressRef.current = false;
    if (!onLongPress) return;
    pressTimerRef.current = setTimeout(() => {
      didLongPressRef.current = true;
      onLongPress(app);
    }, LONG_PRESS_MS);
  };

  const handlePointerEnd = () => {
    clearTimer();
  };

  const handleClick = () => {
    if (didLongPressRef.current) {
      didLongPressRef.current = false;
      return;
    }
    onOpen(app);
  };

  return (
    <Box
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onPointerLeave={handlePointerEnd}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(app);
        }
      }}
      sx={(theme) => ({
        // Cell content stack: square glyph + caption name.
        // Width is left to the parent grid cell so the tile
        // sizes itself fluidly across viewport widths.
        //
        // `minWidth: 0` + `alignItems: stretch` together force
        // the inner glyph to take exactly the cell's width even
        // when the caption underneath is longer than the cell.
        // Without this, a long caption can push the cell wider
        // than its `1fr` share, breaking the "all tiles same
        // size" invariant. The grid parent also uses
        // `minmax(0, 1fr)` (see `AppsTabView` PinnedGrid) which
        // is the other half of the fix.
        width: '100%',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        cursor: 'pointer',
        userSelect: 'none',
        WebkitTapHighlightColor: 'transparent',
        // Pop-in animation. Gated on `isNew` so it fires only
        // when the user *just* pinned this app (the host's
        // `PinnedGrid` diffs the id set across renders to
        // identify newcomers); on the very first render of the
        // panel and on plain re-renders the tile mounts in its
        // final state without animating.
        //
        // The 80 ms delay lines up with the star pulse on the
        // source button (`AppCompactTile`'s `star-pulse`
        // keyframe is 250 ms with a peak around 100 ms): the
        // star kicks first, then the tile arrives, giving a
        // perceived sequence "click → reaction → result"
        // without needing a literal fly-to-dock transition.
        animation: isNew
          ? 'pinned-tile-pop-in 240ms cubic-bezier(0.34, 1.56, 0.64, 1) 80ms both'
          : 'none',
        '@keyframes pinned-tile-pop-in': {
          '0%': { opacity: 0, transform: 'scale(0.7)' },
          '100%': { opacity: 1, transform: 'scale(1)' },
        },
        '&:focus-visible': {
          outline: `2px solid ${theme.palette.primary.main}`,
          outlineOffset: 2,
          borderRadius: `${RADIUS.lg}px`,
        },
        '&:active .pinned-tile-glyph': {
          transform: 'scale(0.95)',
        },
      })}
    >
      <Box
        className="pinned-tile-glyph"
        sx={(theme) => ({
          width: '100%',
          // Perfect square. Cell width is driven by the parent
          // 3-column grid so the square scales with the viewport.
          aspectRatio: '1 / 1',
          borderRadius: `${RADIUS.lg}px`,
          bgcolor: 'background.paper',
          border: `1px solid ${theme.palette.divider}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          // Big-glyph treatment: the emoji IS the icon. Sized to
          // a comfortable thumb-glance even on the smallest mobile
          // viewports we target (~360 px width).
          fontSize: 44,
          lineHeight: 1,
          // Bracket the box: explicit `box-sizing: border-box`
          // so the 1 px border doesn't push the square off
          // its `aspectRatio` calculation in some Safari
          // versions.
          boxSizing: 'border-box',
          transition: theme.transitions.create('transform', {
            duration: theme.transitions.duration.shortest,
          }),
        })}
      >
        {emoji}
      </Box>
      <Typography
        sx={{
          mt: 0.75,
          width: '100%',
          fontSize: TYPO.tiny,
          fontWeight: FONT_WEIGHT.medium,
          color: 'text.secondary',
          textAlign: 'center',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          lineHeight: 1.2,
        }}
      >
        {app.name}
      </Typography>
    </Box>
  );
}

export default memo(AppPinnedTileImpl);
