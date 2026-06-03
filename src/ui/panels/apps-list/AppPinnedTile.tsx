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
 *   - Each tile gains a small `✕` badge on the top-right corner of
 *     its glyph plate, mirroring the iOS Home Screen jiggle-mode
 *     delete affordance.
 *   - The whole cell wiggles subtly (~1° amplitude with a tiny
 *     vertical bob) to reinforce the "this is editable now"
 *     signal. To avoid the "all tiles dance in lockstep" effect
 *     that reads as a sync animation rather than an iOS-style
 *     jiggle, each tile gets a per-id-derived phase offset, a
 *     small duration jitter, and one of two mirrored keyframes
 *     (clockwise-first vs counter-clockwise-first). All of this
 *     respects `prefers-reduced-motion`.
 *   - Tapping the tile body is a no-op; only the `✕` removes the
 *     pin. Tap `Done` in the header to exit.
 *
 * The earlier draft used a 500 ms long-press to unpin, which was
 * fast but completely undiscoverable: users had no way to know
 * the gesture existed without being told. The Edit/Done toggle
 * trades a tap for full discoverability.
 */
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  type ForwardRefExoticComponent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefAttributes,
} from 'react';
import { Box, IconButton, Typography, alpha } from '@mui/material';
import TouchRippleRaw, {
  type TouchRippleActions,
  type TouchRippleProps,
} from '@mui/material/ButtonBase/TouchRipple';
import CloseIcon from '@mui/icons-material/Close';

import type { AppEntry } from '@/features/apps/types';
import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';
import AppIcon from './AppIcon';

// MUI ships `TouchRipple` as a `ForwardRefRenderFunction` rather than
// a `ForwardRefExoticComponent`, which TypeScript refuses to treat as
// a JSX element type. Cast through to the runtime-equivalent
// component shape so we can `<TouchRipple ref={...} />` without TS
// complaining. This is a known MUI typing gap (see e.g.
// mui/material-ui#33174); the runtime behaviour is unaffected.
const TouchRipple = TouchRippleRaw as unknown as ForwardRefExoticComponent<
  TouchRippleProps & RefAttributes<TouchRippleActions>
>;

/**
 * Stable per-id 32-bit hash. Java-style polynomial rolling hash
 * (`s = s * 31 + c`) — good enough distribution for the wiggle
 * jitter derived below, and deterministic so the same pinned app
 * picks the same phase / duration / variant on every render
 * (re-toggling Edit doesn't shuffle the choreography).
 */
function tileSeed(id: string): number {
  let s = 0;
  for (let i = 0; i < id.length; i++) {
    s = (s * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(s);
}

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
  // Material-style ripple, scoped to the glyph plate via the
  // `position: relative + overflow: hidden` slot below. We drive
  // it manually (instead of swapping the wrapper for `ButtonBase`)
  // for two reasons:
  //   1. `ButtonBase` rips its own ripple as a sibling of the
  //      child tree; that ripple would extend to the caption
  //      under the square and read as a rectangular flash instead
  //      of an iOS-style icon press.
  //   2. The outer cell already owns its own `role="button"` +
  //      keyboard handling, focus styles, wiggle animation,
  //      pop-in animation, and active-scale on the glyph plate.
  //      A bare `<TouchRipple>` lets us layer the ripple in
  //      without re-deriving any of that machinery from
  //      `ButtonBase`.
  const rippleRef = useRef<TouchRippleActions>(null);

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (editMode) return;
    rippleRef.current?.start(e);
  };

  const handlePointerUp = (e: PointerEvent<HTMLDivElement>) => {
    rippleRef.current?.stop(e);
  };

  // Cancel the wave if the pointer leaves the tile mid-press; the
  // alternative (let it complete) reads as "the system reacted to
  // a tap I aborted", which is the exact opposite of the
  // touch-cancel UX users expect on iOS.
  const handlePointerLeave = (e: PointerEvent<HTMLDivElement>) => {
    rippleRef.current?.stop(e);
  };

  // Delay between the user's tap and the actual `onOpen` so the
  // ripple wave has time to draw before the host swaps the
  // current view for the iframe overlay. Without this gap, the
  // overlay paints on top of the still-expanding ripple within
  // a frame or two and the press feels "swallowed". ~220 ms is
  // the sweet spot we found in mobile usability passes: long
  // enough to read the wave as a "your tap was registered" cue,
  // short enough that the open still feels immediate.
  const OPEN_AFTER_RIPPLE_MS = 220;
  const openTimerRef = useRef<number | null>(null);

  // Clear a pending open if the tile unmounts (parent re-renders
  // the grid, edit mode flips, hot reload) so we don't fire
  // `onOpen` against a stale app reference.
  useEffect(() => {
    return () => {
      if (openTimerRef.current !== null) {
        window.clearTimeout(openTimerRef.current);
        openTimerRef.current = null;
      }
    };
  }, []);

  const handleClick = () => {
    // Edit mode disables opening; the only actionable element on
    // an editing tile is the badge below.
    if (editMode) return;
    // Idempotent: a double-tap during the ripple window should
    // not queue a second open. The first tap already armed the
    // timer; subsequent taps are no-ops until it resolves.
    if (openTimerRef.current !== null) return;
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null;
      onOpen(app);
    }, OPEN_AFTER_RIPPLE_MS);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editMode) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (openTimerRef.current !== null) return;
      // Centered ripple on keyboard activation: we have no pointer
      // coordinates to anchor against, so a centered wave is the
      // honest representation of "the tile was activated".
      rippleRef.current?.start(
        // `TouchRipple.start` accepts a synthetic stub with just
        // the `clientX/clientY` fields it reads. We pass zeros and
        // ignore them via `{ center: true }`.
        { clientX: 0, clientY: 0 } as unknown as PointerEvent<HTMLDivElement>,
        { center: true },
      );
      // Stop the ripple just before we open so the wave's fade-out
      // overlaps with the host swap, mirroring what the pointer
      // path naturally gets via `onPointerUp`.
      openTimerRef.current = window.setTimeout(() => {
        openTimerRef.current = null;
        rippleRef.current?.stop({} as PointerEvent<HTMLDivElement>);
        onOpen(app);
      }, OPEN_AFTER_RIPPLE_MS);
    }
  };

  const handleUnpinClick = (e: MouseEvent<HTMLElement>) => {
    // Stop propagation so the surrounding tile's click handler
    // doesn't also fire (a no-op while editing, but defensive).
    e.stopPropagation();
    onUnpin?.(app);
  };

  // Per-tile wiggle choreography. Stable on `app.id` so the same
  // tile picks the same phase / duration / variant every time edit
  // mode flips on, but pseudo-random across the grid so we don't
  // get a "synchronised dance" reading.
  //
  //   - `wiggleDelayMs` is NEGATIVE: CSS treats that as "the
  //     animation started this many ms before now", so the tile
  //     enters at a random phase of its loop instead of all tiles
  //     starting at frame 0 together.
  //   - `wiggleDurationMs` jitters ±20% around 560 ms so neighbouring
  //     tiles drift in and out of phase over time even if their
  //     starting offsets happen to land close. iOS does the same.
  //   - `wiggleVariant` picks one of two mirrored keyframes — half
  //     the grid leans clockwise first, the other half counter-
  //     clockwise. Adds visual diversity without inventing extra
  //     motion vocabulary.
  const { wiggleDelayMs, wiggleDurationMs, wiggleVariant } = useMemo(() => {
    const seed = tileSeed(app.id);
    return {
      wiggleDelayMs: -(seed % 560),
      wiggleDurationMs: 480 + ((seed >>> 3) % 160),
      wiggleVariant: seed % 2 === 0 ? 'a' : 'b',
    } as const;
  }, [app.id]);

  return (
    <Box
      role={editMode ? undefined : 'button'}
      tabIndex={editMode ? -1 : 0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onPointerCancel={handlePointerLeave}
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
        //
        // Wiggle: per-tile phase + duration + variant (see the
        // `useMemo` above) so the grid reads as a crowd of
        // independent jiggles, not a synchronised metronome.
        animation: editMode
          ? `pinned-tile-wiggle-${wiggleVariant} ${wiggleDurationMs}ms ease-in-out ${wiggleDelayMs}ms infinite`
          : isNew
            ? 'pinned-tile-pop-in 240ms cubic-bezier(0.34, 1.56, 0.64, 1) 80ms both'
            : 'none',
        // `transform-origin: center` so the small rotation pivots
        // around the tile's geometric centre (default for blocks
        // anyway, made explicit so a future caller's container
        // styling can't accidentally shift the pivot off-axis and
        // turn the jiggle into a wobble).
        transformOrigin: 'center',
        '@keyframes pinned-tile-pop-in': {
          '0%': { opacity: 0, transform: 'scale(0.7)' },
          '100%': { opacity: 1, transform: 'scale(1)' },
        },
        // Two mirrored wiggle keyframes. Same amplitude envelope,
        // same total energy, opposite starting direction. Each
        // also includes a sub-pixel vertical bob in opposition to
        // the rotation phase so the tile reads as "alive" rather
        // than "rigidly rotating about its centre". The bob is
        // 0.5 px max — any larger and tiles in a row start to
        // collide visually with their captions.
        '@keyframes pinned-tile-wiggle-a': {
          '0%, 100%': { transform: 'rotate(-1deg) translateY(0)' },
          '25%': { transform: 'rotate(1deg) translateY(-0.5px)' },
          '50%': { transform: 'rotate(-0.7deg) translateY(0)' },
          '75%': { transform: 'rotate(1deg) translateY(0.5px)' },
        },
        '@keyframes pinned-tile-wiggle-b': {
          '0%, 100%': { transform: 'rotate(1deg) translateY(0)' },
          '25%': { transform: 'rotate(-1deg) translateY(0.5px)' },
          '50%': { transform: 'rotate(0.7deg) translateY(0)' },
          '75%': { transform: 'rotate(-1deg) translateY(-0.5px)' },
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
          // Constant (near-)white plate in BOTH modes: app icons /
          // logos are authored on the assumption of a light backing, so
          // a dark paper plate in dark mode would muddy them. Slightly
          // translucent (0.8) so it's not a stark pure-white block.
          bgcolor: alpha(theme.palette.common.white, 0.15),
          // Subtle primary tint on the border so a pinned tile
          // reads as "user-curated / first-class" against the
          // divider-grey of generic surfaces, without screaming
          // for attention (full primary at 1 px would compete
          // with the icon's own colour). Alpha kept on the
          // lighter side of "outlined primary button" so it
          // stays readable on both light and dark backgrounds
          // via alpha-on-current-bg composition.
          //
          // Edit mode falls back to neutral `divider`: the
          // primary tint signals "this app is a user-curated
          // pin", which is only meaningful in the calm reading
          // state. In edit mode every tile is wiggling under a
          // `✕` badge and we want the whole grid to read as a
          // single editing surface rather than as a row of
          // accented buttons.
          border: `1px solid ${editMode ? theme.palette.divider : alpha(theme.palette.primary.main, 0.6)}`,
          // `position: relative` so the ripple slot below can
          // attach as an absolute child clipped to the plate's
          // rounded square (without affecting the icon's
          // `overflow: visible` bleed).
          position: 'relative',
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

        {/* Ripple slot.
            ───────────
            Dedicated absolute layer over the glyph plate that
            owns the Material `TouchRipple`. We host it here (not
            on the outer wrapper) for two reasons:
              - `overflow: hidden` on this slot clips the wave to
                the exact rounded square of the plate, so the
                ripple never bleeds onto the caption below.
              - The outer wrapper keeps `overflow: visible` so
                the icon can continue to bleed past the plate's
                border (see `imageSize: 117` comment above).
            `pointerEvents: none` so the slot itself stays
            transparent to hit-testing — clicks still resolve on
            the outer button. `zIndex: 1` lays the wave just
            above the icon so a tap on a photographic logo still
            reads as a press; the wave's own alpha (~0.3) keeps
            the icon legible underneath. Suppressed in edit mode:
            the tile body is non-interactive then, so a ripple
            would be a phantom signal. */}
        {!editMode && (
          <Box
            aria-hidden
            sx={{
              position: 'absolute',
              inset: 0,
              borderRadius: `${RADIUS.lg}px`,
              overflow: 'hidden',
              pointerEvents: 'none',
              zIndex: 1,
              // Tint the ripple wave with the primary palette.
              // MUI's `TouchRipple` paints the wave in
              // `currentColor`, so setting `color` on the slot
              // is enough — no need to override
              // `TouchRippleProps.classes`. Matches the primary
              // border above so the press echoes the same
              // "user-curated / first-class" colour family.
              color: 'primary.main',
            }}
          >
            <TouchRipple ref={rippleRef} center={false} />
          </Box>
        )}
      </Box>

      {/* Edit-mode unpin badge.
          ────────────────────
          Sits half-off the glyph plate's top-right corner. We
          deliberately diverge from iOS's top-LEFT placement here:
          the user's thumb naturally rests on the right side of
          the screen on a phone held one-handed, so a right-side
          delete badge minimises hand travel between the Edit/Done
          toggle (top-right of the panel) and the destructive
          action on each tile. The button is the ONLY actionable
          element on the tile while editing; the surrounding cell
          ignores clicks.

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
            right: -6,
            width: 22,
            height: 22,
            minWidth: 0,
            padding: 0,
            // Primary-outlined pill, matching the Edit/Done toggle
            // in the panel header so both halves of the unpin
            // affordance (enter edit mode, then remove a tile)
            // read as the same "primary action" family.
            //
            // We give the pill a surface fill (background.paper)
            // rather than a transparent one because it floats on
            // TOP of arbitrary app icons - photographic emoji,
            // dark logos, white logos. Without an opaque fill,
            // the icon's edge bleeds through the outline and the
            // glyph stops reading as a tappable target.
            bgcolor: 'background.paper',
            color: 'primary.main',
            border: `1.5px solid ${theme.palette.primary.main}`,
            boxShadow: theme.shadows[1],
            zIndex: 2,
            transition: theme.transitions.create(
              ['transform', 'background-color'],
              { duration: theme.transitions.duration.shortest },
            ),
            // Subtle primary tint on hover / press, mirroring
            // MUI's outlined-Button feedback (`alpha(primary, 0.04)`
            // hover, `0.12` press). Stronger on press so a finger
            // tap registers visually even though the surrounding
            // tile is also wiggling.
            '&:hover': {
              bgcolor: alpha(theme.palette.primary.main, 0.08),
            },
            '&:active': {
              transform: 'scale(0.9)',
              bgcolor: alpha(theme.palette.primary.main, 0.16),
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
