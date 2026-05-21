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
 * Interaction model
 * ─────────────────
 * Tap = open the app. To remove a pinned app, the user enters the
 * grid's "edit mode" from the `Edit` button in the panel header,
 * which flips `editMode` on every tile. While editing:
 *
 *   - Each tile gains a small `✕` badge on the top-left corner of
 *     its glyph plate, mirroring the iOS Home Screen jiggle-mode
 *     delete affordance.
 *   - The whole cell wiggles subtly (~0.7° amplitude) to reinforce
 *     the "this is editable now" signal. The wiggle respects
 *     `prefers-reduced-motion`.
 *   - Tapping the tile body is a no-op; only the `✕` removes the
 *     pin. Tap `Done` in the header to exit.
 *
 * The earlier draft used a 500 ms long-press to unpin, which was
 * fast but completely undiscoverable: users had no way to know
 * the gesture existed without being told. The Edit/Done toggle
 * trades a tap for full discoverability.
 */
import { memo, type KeyboardEvent, type MouseEvent } from 'react';
import { Box, IconButton, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';

import type { AppEntry } from '@/features/apps/types';
import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';
import AppIcon from './AppIcon';

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
  /**
   * `true` while the parent grid is in "edit mode" (the user
   * tapped `Edit` in the header). Renders the unpin badge on
   * the glyph plate and disables tile open; the wiggle animation
   * is gated on the same flag.
   */
  editMode?: boolean;
  onOpen: (app: AppEntry) => void;
  /**
   * Fired when the user taps the `✕` badge while `editMode`.
   * Omitted in surfaces that don't expose unpin (currently none;
   * the only consumer is the pinned grid, but keeping it optional
   * makes the tile reusable in passive contexts).
   */
  onUnpin?: (app: AppEntry) => void;
}

function AppPinnedTileImpl({
  app,
  isNew = false,
  editMode = false,
  onOpen,
  onUnpin,
}: AppPinnedTileProps) {
  const handleClick = () => {
    // Edit mode disables opening; the only actionable element on
    // an editing tile is the badge below.
    if (editMode) return;
    onOpen(app);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editMode) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen(app);
    }
  };

  const handleUnpinClick = (e: MouseEvent<HTMLElement>) => {
    // Stop propagation so the surrounding tile's click handler
    // doesn't also fire (a no-op while editing, but defensive).
    e.stopPropagation();
    onUnpin?.(app);
  };

  return (
    <Box
      role={editMode ? undefined : 'button'}
      tabIndex={editMode ? -1 : 0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
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
        // The unpin badge is absolutely positioned against this
        // outer column so it can extend a few px past the glyph
        // plate (iOS-style "off-tile" delete dot).
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        cursor: editMode ? 'default' : 'pointer',
        userSelect: 'none',
        WebkitTapHighlightColor: 'transparent',
        // Animation: pop-in on first pin OR jiggle while editing.
        // Edit mode wins because the two states are mutually
        // exclusive in practice (a brand-new pin can't be
        // unpinned until the user opens edit mode, by which time
        // the pop-in is long over).
        //
        // The 80 ms delay on pop-in lines up with the star pulse
        // on the source button (`AppCompactTile`'s `star-pulse`
        // keyframe is 250 ms with a peak around 100 ms): the
        // star kicks first, then the tile arrives, giving a
        // perceived sequence "click → reaction → result" without
        // needing a literal fly-to-dock transition.
        animation: editMode
          ? 'pinned-tile-wiggle 480ms ease-in-out infinite'
          : isNew
            ? 'pinned-tile-pop-in 240ms cubic-bezier(0.34, 1.56, 0.64, 1) 80ms both'
            : 'none',
        '@keyframes pinned-tile-pop-in': {
          '0%': { opacity: 0, transform: 'scale(0.7)' },
          '100%': { opacity: 1, transform: 'scale(1)' },
        },
        '@keyframes pinned-tile-wiggle': {
          '0%, 100%': { transform: 'rotate(-0.7deg)' },
          '50%': { transform: 'rotate(0.7deg)' },
        },
        // Accessibility: kill the wiggle for users who opted out
        // of system motion. The pop-in is short enough that we
        // could leave it, but cutting all animation on this tile
        // is the safer blanket policy.
        '@media (prefers-reduced-motion: reduce)': {
          animation: 'none',
        },
        '&:focus-visible': {
          outline: `2px solid ${theme.palette.primary.main}`,
          outlineOffset: 2,
          borderRadius: `${RADIUS.lg}px`,
        },
        // Press feedback only outside edit mode (in edit mode the
        // tile body is non-interactive).
        '&:active .pinned-tile-glyph': {
          transform: editMode ? 'none' : 'scale(0.95)',
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
          // Bracket the box: explicit `box-sizing: border-box`
          // so the 1 px border doesn't push the square off
          // its `aspectRatio` calculation in some Safari
          // versions.
          boxSizing: 'border-box',
          // The custom icon is rendered LARGER than this plate on
          // purpose (see `imageSize` below). Two CSS gotchas to
          // neutralise so the plate stays a perfect square anyway:
          //
          //   - As a flex item in the outer column, our default
          //     `min-height: auto` would expand the plate to fit
          //     the icon's intrinsic size, overriding the
          //     `aspectRatio` we just set. `min-height: 0` opts
          //     out of that.
          //
          //   - `overflow: visible` (already the default) lets the
          //     icon bleed past the plate's border; we keep it
          //     explicit so nothing further down the cascade
          //     accidentally clips it.
          minHeight: 0,
          overflow: 'visible',
          transition: theme.transitions.create('transform', {
            duration: theme.transitions.duration.shortest,
          }),
        })}
      >
        {/* Big-glyph treatment: the icon (or emoji fallback) IS
            the visual identity.
              - Emoji stays at 44 px (the legacy baseline; a chunky
                emoji at 88 px reads as cartoonish next to the
                caption).
              - A custom PNG icon renders at 117 px (≈ +1/3 vs the
                previous 88) so it overflows the ~96 px tile by a
                few pixels on each side. The bleed mirrors the
                compact-tile treatment (`AppCompactTile`) and gives
                the icon real "home-screen hero" presence. The
                square plate itself does NOT grow - we keep the
                grid layout stable and let the glyph extend past
                the plate's border.
              - SVG glyphs stay inside the plate at 72 px because
                they typically ship edge-to-edge artwork with no
                internal padding; the bleed treatment that flatters
                a padded PNG reads as oversized on an SVG. */}
        <AppIcon app={app} size={44} imageSize={117} svgImageSize={72} />
      </Box>

      {/* Edit-mode unpin badge.
          ────────────────────
          Sits half-off the glyph plate's top-left corner, matching
          the iOS Home Screen jiggle-mode delete dot. The button is
          the ONLY actionable element on the tile while editing;
          the surrounding cell ignores clicks.

          We render it after the glyph so it stacks above without
          needing an explicit z-index above the icon overflow (the
          PNG icon extends past the plate). The IconButton is a
          native focus stop so keyboard users can tab onto it
          directly. */}
      {editMode && onUnpin && (
        <IconButton
          aria-label={`Unpin ${app.name}`}
          onClick={handleUnpinClick}
          // The cell itself is wiggling; the badge inherits the
          // rotation. Counter-rotate not worth the cost - the
          // amplitude is small enough that the badge stays
          // perfectly hit-test-able and reads as part of the
          // editable surface.
          sx={(theme) => ({
            position: 'absolute',
            top: -6,
            left: -6,
            width: 22,
            height: 22,
            minWidth: 0,
            padding: 0,
            // High-contrast pill: dark in light mode, light in
            // dark mode. The badge must read clearly against
            // ANY app icon (white logos, dark logos, photographic
            // emoji), so we lean on a strong fill + a thin
            // surface-coloured ring so it always pops off the
            // plate underneath.
            bgcolor:
              theme.palette.mode === 'dark'
                ? theme.palette.grey[100]
                : theme.palette.grey[900],
            color:
              theme.palette.mode === 'dark'
                ? theme.palette.grey[900]
                : theme.palette.common.white,
            border: `2px solid ${theme.palette.background.default}`,
            boxShadow: theme.shadows[2],
            zIndex: 2,
            transition: theme.transitions.create(['transform', 'opacity'], {
              duration: theme.transitions.duration.shortest,
            }),
            '&:hover': {
              bgcolor:
                theme.palette.mode === 'dark'
                  ? theme.palette.grey[200]
                  : theme.palette.grey[800],
            },
            '&:active': {
              transform: 'scale(0.9)',
            },
          })}
        >
          <CloseIcon sx={{ fontSize: 14 }} />
        </IconButton>
      )}

      <Typography
        sx={{
          mt: 0.75,
          width: '100%',
          fontSize: TYPO.tiny,
          // Bold so the pinned-app caption reads as a label
          // ("this is THE name of the app I chose") rather than a
          // secondary descriptor. Mirrors the iOS home-screen
          // pattern where the icon's caption is visually heavier
          // than the surrounding chrome, so a glance lands on the
          // app name first.
          fontWeight: FONT_WEIGHT.bold,
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
