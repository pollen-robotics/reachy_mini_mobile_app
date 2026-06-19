/**
 * Twitter-style heart like button used in the apps store tiles.
 *
 * The base behaviour - tap to toggle, optimistic state, disabled
 * when signed-out - is unchanged from the inline implementation
 * that used to live in `AppCompactTile`. What this component adds
 * is a richer, more "satisfying" toggle animation when the user
 * goes from `unliked → liked`:
 *
 *   1. The heart squishes (scale 0.7) for a frame of anticipation.
 *   2. It pops back up past 1.0 with overshoot and the colour
 *      transitions from `text.secondary` to `error.main`.
 *   3. A thin ring expands behind the heart and fades out (the
 *      "splash" effect).
 *   4. A randomised batch of particles flies radially outward,
 *      rotating, then scales down + fades as it reaches its
 *      apogee.
 *   5. The count next to the heart gets a small confirmation
 *      bump so the value-change reads as intentional.
 *
 * Going `liked → unliked` is intentionally quieter (just a soft
 * shrink): you don't want a confetti burst when someone unlikes
 * something.
 *
 * Per-click randomisation
 * -----------------------
 * `generateBurst()` picks a fresh particle count, angle phase,
 * per-particle jitter, distance, size, colour, rotation, shape
 * and delay every time the user likes. No two bursts look quite
 * the same, which keeps the affordance feeling alive rather than
 * canned.
 *
 * Escape-the-tile (`Portal`)
 * --------------------------
 * The parent tile uses `overflow: hidden` to clip rounded
 * corners. A satisfying burst on mobile needs to extend ~60-70px
 * beyond the heart (the user's thumb covers most of the inner
 * 50px area), so the burst can't live inside the tile - it would
 * be clipped to a few px.
 *
 * We solve this by rendering the burst through a MUI `Portal`
 * anchored to the heart's *viewport* coordinates (`fixed`
 * position). The heart wrapper still owns the icon's pop
 * animation; the portal layer owns the ring + particle storm,
 * sitting above any tile chrome with `pointer-events: none` so
 * it never steals taps.
 *
 * Accessibility
 * -------------
 * Respects `prefers-reduced-motion`: the burst overlay is skipped
 * entirely (no portal, no particles) and only the colour swap +
 * tiny scale on the icon remain. The button itself keeps
 * `aria-pressed` / `aria-label` semantics so screen readers
 * announce the toggle correctly.
 */
import {
  memo,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import {
  Box,
  ButtonBase,
  Portal,
  Typography,
  useMediaQuery,
} from '@mui/material';
import FavoriteIcon from '@mui/icons-material/Favorite';
import FavoriteBorderIcon from '@mui/icons-material/FavoriteBorder';

import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';

interface LikeButtonProps {
  isLiked: boolean;
  /** False when signed-out - the button degrades to a static read-only badge. */
  canToggle: boolean;
  /** Display count (already includes the optimistic +1/-1 delta). */
  count: number;
  onToggle: () => void;
  ariaLabel: string;
}

/**
 * Palette for the particle storm. Warm half of the wheel only
 * (reds / pinks / oranges / a single gold) so the burst reads as
 * an extension of the heart's `error.main` rather than a random
 * rainbow. The duplication ratio (more reds than oranges) biases
 * the average tone toward red without us having to hand-pick a
 * per-particle weight.
 */
const PARTICLE_COLORS = [
  '#ff3b6b',
  '#ff476b',
  '#ff2d55',
  '#d23a6b',
  '#ff5b95',
  '#ff7799',
  '#ff6bc6',
  '#ffaa66',
] as const;

/**
 * Total time the portal stays mounted per burst. The particle
 * keyframe runs for `BURST_DURATION_MS`, the ring is slightly
 * shorter so it dissolves before the last dots settle - that
 * stagger keeps the burst from feeling "cut" at the end.
 */
const BURST_DURATION_MS = 700;

interface Particle {
  angle: number;
  distance: number;
  size: number;
  color: string;
  delay: number;
  rotate: number;
  shape: 'circle' | 'square';
}

interface Burst {
  id: number;
  /** Viewport coordinates (px) - portal uses `position: fixed`. */
  cx: number;
  cy: number;
  particles: Particle[];
}

/**
 * Monotonic id for portal bursts. Lives at module scope so two
 * adjacent like buttons can't accidentally collide on `key`s if
 * they fire bursts in the same tick.
 */
let nextBurstId = 0;

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function pickColor(): string {
  return PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)];
}

/**
 * Build a fresh particle batch for one burst.
 *
 * Geometry strategy
 * -----------------
 * Particles are seeded around a regular polygon (one slice per
 * particle), then each angle is jittered by ±25 % of the slice
 * width. That keeps the burst visually balanced - no big empty
 * arcs - while still feeling organic. A full random `0-360°` per
 * particle tends to cluster, leaving naked sides.
 *
 * Sizes, distances, delays and rotations are sampled inside
 * tight bands so every burst stays within the same "weight
 * class" but never repeats exactly.
 */
function generateBurst(cx: number, cy: number): Burst {
  const count = 6 + Math.floor(Math.random() * 3); // 6-8 particles
  const phase = Math.random() * 360; // global rotation of the ring
  const slice = 360 / count;
  const particles: Particle[] = Array.from({ length: count }, (_, i) => ({
    angle: phase + slice * i + randomBetween(-slice * 0.25, slice * 0.25),
    distance: randomBetween(32, 50),
    size: randomBetween(3.5, 6),
    color: pickColor(),
    delay: randomBetween(0, 40),
    rotate: randomBetween(-120, 120),
    // Mostly circles, with the occasional rounded square thrown in
    // so the storm has a hint of variety without drawing the eye.
    shape: Math.random() < 0.8 ? 'circle' : 'square',
  }));
  return { id: ++nextBurstId, cx, cy, particles };
}

function LikeButtonImpl({
  isLiked,
  canToggle,
  count,
  onToggle,
  ariaLabel,
}: LikeButtonProps) {
  const prefersReducedMotion = useMediaQuery(
    '(prefers-reduced-motion: reduce)',
  );

  // Bump on every toggle so the icon / count layers remount via
  // `key`, which re-plays their CSS keyframes (assigning the same
  // animation name doesn't retrigger on its own).
  const [animKey, setAnimKey] = useState(0);
  // Only the like → unlike transition produces a burst. We track
  // the "last action" so we can show the burst conditionally
  // without re-firing it when the parent re-renders for unrelated
  // reasons (cache update, count tick, ...).
  const [lastAction, setLastAction] = useState<'liked' | 'unliked' | null>(
    null,
  );
  // Active bursts. Each entry is a snapshot of viewport coords +
  // particle batch captured at click time, rendered through a
  // portal and removed by a timer when its animation completes.
  // We keep them in an array (not a single slot) so a user who
  // spam-likes two robots in quick succession sees both storms
  // overlap rather than one cancelling the other.
  const [bursts, setBursts] = useState<Burst[]>([]);
  const heartRef = useRef<HTMLSpanElement>(null);

  const HeartIcon = isLiked ? FavoriteIcon : FavoriteBorderIcon;

  const handleClick = (e: MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    e.preventDefault();
    if (!canToggle) return;
    const willLike = !isLiked;
    setLastAction(willLike ? 'liked' : 'unliked');
    setAnimKey((k) => k + 1);
    if (willLike && !prefersReducedMotion) {
      const rect = heartRef.current?.getBoundingClientRect();
      if (rect) {
        const burst = generateBurst(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        setBursts((prev) => [...prev, burst]);
        // Drop the burst from state once its animation is done
        // so the portal node + its DOM children are recycled.
        window.setTimeout(() => {
          setBursts((prev) => prev.filter((b) => b.id !== burst.id));
        }, BURST_DURATION_MS + 80);
      }
    }
    onToggle();
  };

  return (
    <ButtonBase
      onClick={handleClick}
      disabled={!canToggle}
      disableRipple
      aria-label={ariaLabel}
      aria-pressed={canToggle ? isLiked : undefined}
      sx={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.25,
        flexShrink: 0,
        // Inner padding sets the *visual* hover/press footprint
        // (the rounded background swatch on hover). The actual
        // tap target is much larger - see the `::after`
        // pseudo-element below.
        px: 0.5,
        py: 0.25,
        mx: -0.5,
        borderRadius: `${RADIUS.sm}px`,
        cursor: canToggle ? 'pointer' : 'default',
        // Keep the row (count) neutral; only the heart icon below
        // carries the brand colour when liked.
        color: 'text.secondary',
        transition: 'color 220ms ease, background-color 120ms ease',
        '&:hover': canToggle ? { bgcolor: 'action.hover' } : undefined,
        '&.Mui-disabled': {
          color: 'text.secondary',
          opacity: 1,
        },
        // Invisible hit-target overlay. Pushes the clickable area
        // ~12 px past the visible heart on every side so a thumb
        // doesn't need pixel-perfect aim on mobile - matches the
        // ~44×44 pt minimum tap target Apple HIG and Material
        // guidelines recommend. Stays transparent and doesn't
        // capture pointer-events on its own (the ButtonBase
        // itself receives the click thanks to event bubbling
        // through the parent element).
        '&::after': {
          content: '""',
          position: 'absolute',
          inset: '-12px',
          // Keep the overlay above any sibling content but below
          // the burst portal so it never traps animations.
          zIndex: 1,
        },
      }}
    >
      {/* Heart wrapper. Owns the icon's pop animation and exposes
          a ref the burst code uses to snapshot the viewport
          coordinates at click time. Kept `pointer-events: none`
          so events bubble to the ButtonBase parent. */}
      <Box
        ref={heartRef}
        sx={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: TYPO.lg,
          height: TYPO.lg,
          pointerEvents: 'none',
        }}
      >
        <HeartIcon
          key={`heart-${animKey}-${isLiked ? 'on' : 'off'}`}
          sx={{
            fontSize: TYPO.lg,
            // Heart is the only coloured element: a primary outline
            // when not liked, a solid red fill once liked.
            color: isLiked ? 'error.main' : 'primary.main',
            // Two distinct keyframes:
            // - `like-pop`: full anticipation + overshoot on the
            //   like-up transition, paired with the portal burst.
            // - `like-shrink`: quieter shrink on the unlike-down
            //   transition (no burst).
            // Reduced-motion users get neither.
            animation: prefersReducedMotion
              ? 'none'
              : lastAction === 'liked' && animKey > 0
                ? 'like-pop 440ms cubic-bezier(0.34, 1.56, 0.64, 1)'
                : lastAction === 'unliked' && animKey > 0
                  ? 'like-shrink 260ms cubic-bezier(0.4, 0, 0.2, 1)'
                  : 'none',
            '@keyframes like-pop': {
              '0%': { transform: 'scale(1)' },
              '20%': { transform: 'scale(0.75)' },
              '50%': { transform: 'scale(1.35)' },
              '75%': { transform: 'scale(0.95)' },
              '100%': { transform: 'scale(1)' },
            },
            '@keyframes like-shrink': {
              '0%': { transform: 'scale(1)' },
              '50%': { transform: 'scale(0.78)' },
              '100%': { transform: 'scale(1)' },
            },
          }}
        />
      </Box>
      <Typography
        key={`count-${animKey}`}
        component="span"
        sx={{
          fontSize: TYPO.md,
          fontWeight: FONT_WEIGHT.semibold,
          color: 'inherit',
          lineHeight: 1,
          display: 'inline-block',
          // Small confirmation bump so the value-change reads as
          // intentional rather than "the number just ticked".
          // Skipped on initial mount and for reduced-motion users.
          animation:
            !prefersReducedMotion && animKey > 0
              ? 'like-count-bump 280ms cubic-bezier(0.34, 1.56, 0.64, 1)'
              : 'none',
          '@keyframes like-count-bump': {
            '0%': { transform: 'scale(1)' },
            '45%': { transform: 'scale(1.1)' },
            '100%': { transform: 'scale(1)' },
          },
        }}
      >
        {count}
      </Typography>

      {/* Burst portal layer. One Portal per active burst (so a
          rapid double-like overlaps two storms cleanly). The
          outer Box anchors all the FX at the heart's centre via
          fixed positioning - escaping the tile's `overflow:
          hidden` so particles can fly past the card edges. */}
      {bursts.map((burst) => (
        <Portal key={burst.id}>
          <Box
            aria-hidden
            sx={{
              position: 'fixed',
              top: burst.cy,
              left: burst.cx,
              width: 0,
              height: 0,
              pointerEvents: 'none',
              // Above the tile chrome but below MUI's modal/popover
              // layer (1300+). Bursts are transient so the z-index
              // mainly needs to beat the tile borders and shadows.
              zIndex: 1200,
            }}
          >
            {/* Ring "splash" expanding behind the storm. Base
                size is intentionally a bit bigger than the heart
                so the early scale stages already cover the
                thumb's footprint - the user sees the splash even
                before they lift their finger. */}
            <Box
              sx={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                width: 14,
                height: 14,
                marginTop: '-7px',
                marginLeft: '-7px',
                borderRadius: '50%',
                border: '2px solid #ff3b6b',
                opacity: 0,
                animation:
                  'like-ring 520ms cubic-bezier(0.16, 1, 0.3, 1) forwards',
                '@keyframes like-ring': {
                  '0%': {
                    transform: 'scale(0.25)',
                    opacity: 0.7,
                    borderWidth: '2.5px',
                  },
                  '55%': {
                    transform: 'scale(2.6)',
                    opacity: 0.3,
                    borderWidth: '1px',
                  },
                  '100%': {
                    transform: 'scale(3.6)',
                    opacity: 0,
                    borderWidth: '0.5px',
                  },
                },
              }}
            />
            {burst.particles.map((p, i) => {
              const rad = (p.angle * Math.PI) / 180;
              const tx = Math.cos(rad) * p.distance;
              const ty = Math.sin(rad) * p.distance;
              return (
                <Box
                  key={i}
                  sx={{
                    position: 'absolute',
                    top: '50%',
                    left: '50%',
                    width: p.size,
                    height: p.size,
                    marginTop: `-${p.size / 2}px`,
                    marginLeft: `-${p.size / 2}px`,
                    // Mix of circles and slightly-rounded squares
                    // to bump perceived variety per burst.
                    borderRadius: p.shape === 'circle' ? '50%' : '22%',
                    backgroundColor: p.color,
                    opacity: 0,
                    // CSS vars carry the per-particle direction
                    // and rotation so a single shared keyframe
                    // serves the whole batch (cheaper for the
                    // browser than N unique @keyframes).
                    ['--tx' as string]: `${tx}px`,
                    ['--ty' as string]: `${ty}px`,
                    ['--rot' as string]: `${p.rotate}deg`,
                    animation: `like-particle ${BURST_DURATION_MS}ms cubic-bezier(0.18, 0.9, 0.3, 1) forwards`,
                    animationDelay: `${p.delay}ms`,
                    '@keyframes like-particle': {
                      '0%': {
                        transform:
                          'translate(0, 0) scale(0.4) rotate(0deg)',
                        opacity: 0,
                      },
                      '15%': {
                        transform:
                          'translate(calc(var(--tx) * 0.3), calc(var(--ty) * 0.3)) scale(1.1) rotate(calc(var(--rot) * 0.25))',
                        opacity: 0.85,
                      },
                      '55%': {
                        transform:
                          'translate(calc(var(--tx) * 0.85), calc(var(--ty) * 0.85)) scale(0.85) rotate(calc(var(--rot) * 0.7))',
                        opacity: 0.7,
                      },
                      '100%': {
                        transform:
                          'translate(var(--tx), var(--ty)) scale(0.2) rotate(var(--rot))',
                        opacity: 0,
                      },
                    },
                  }}
                />
              );
            })}
          </Box>
        </Portal>
      ))}
    </ButtonBase>
  );
}

export default memo(LikeButtonImpl);
