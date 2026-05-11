/**
 * Reachies carousel.
 *
 * Mobile port of the desktop app store's empty-state carousel
 * (`reachy_mini_desktop_app/src/components/ReachiesCarousel.tsx`),
 * the one rendered in the "No apps installed yet" hero. The
 * desktop variant is the more polished of the two carousels in
 * the codebase, with a fewer-but-richer set of source images,
 * a slower / more "Apple-style" cross-fade, and a baseline
 * opacity so the hero never reads as 100 % saturated.
 *
 * Sources are auto-loaded from
 * `src/assets/reachies/small-top-sided/*.png` via `import.meta.glob`
 * (Vite eager-import); add a PNG there and it lights up in the
 * carousel without any code change.
 *
 * Mobile-side adaptation: the host layout is fluid (the IntroPanel
 * hero box is sized via `aspect-ratio: 1/1` on a viewport-relative
 * grid cell), so we drop the desktop's pixel `width` / `height`
 * props and let the carousel fill its parent (`width: 100%,
 * height: 100%`). The `zoom` factor that used to be applied via
 * `width = width * zoom` is now applied via `transform: scale(zoom)`
 * which is equivalent visually but doesn't depend on resolved
 * pixel dimensions.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, useTheme } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';

// Eager-load every PNG in `small-top-sided/`. Vite hashes them
// at build time and the bundler tree-shakes anything we don't
// reference. Adding or removing a sticker is a drop-in: no
// import to update here, no manual array to maintain.
const imageModules = import.meta.glob(
  '@/assets/reachies/small-top-sided/*.png',
  { eager: true },
);

export interface ReachiesCarouselProps {
  /** Time each image stays fully visible before swapping, in ms. */
  interval?: number;
  /** Fade-in duration of the incoming image. */
  fadeInDuration?: number;
  /** Fade-out duration of the outgoing image. */
  fadeOutDuration?: number;
  /**
   * Visual scale of each frame relative to the container. `1`
   * fits each image inside the container; `> 1` zooms in and
   * relies on the parent's `overflow: hidden` to clip the
   * overflow. Defaults to `1.8`, matching the desktop empty-state
   * framing.
   */
  zoom?: number;
  /**
   * Vertical anchor of each image relative to the container.
   * `'top' | 'center' | 'bottom'` for the common cases, or any
   * percentage string (e.g. `'60%'`) for fine-tuned framing.
   * Defaults to `'center'`.
   */
  verticalAlign?: 'top' | 'center' | 'bottom' | string;
  /** Optional `sx` override for the outer container. */
  sx?: SxProps<Theme>;
}

export default function ReachiesCarousel({
  interval = 1000,
  fadeInDuration = 350,
  fadeOutDuration = 120,
  zoom = 1.8,
  verticalAlign = 'center',
  sx = {},
}: ReachiesCarouselProps) {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  // Apple/Google-style: the active frame caps below 1.0 so the
  // hero reads as polished rather than punchy. Slightly higher
  // in light mode where the page background is paler.
  const baseOpacity = isDark ? 0.8 : 0.9;

  // Resolve the eager-loaded modules to URL strings, sorted for
  // a deterministic order across reloads.
  const imagePaths = useMemo<string[]>(() => {
    return Object.values(imageModules)
      .map((mod: unknown) => {
        if (typeof mod === 'object' && mod !== null && 'default' in mod) {
          return (mod as { default: string }).default;
        }
        return mod as string;
      })
      .filter((p): p is string => Boolean(p))
      .sort();
  }, []);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [previousIndex, setPreviousIndex] = useState<number | null>(null);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [fadeOutComplete, setFadeOutComplete] = useState(false);
  const currentIndexRef = useRef(currentIndex);

  useEffect(() => {
    currentIndexRef.current = currentIndex;
  }, [currentIndex]);

  // Preload all images so the first cycle doesn't flicker on a
  // slow connection (Tauri ships them as part of the bundle, so
  // the network cost is zero - this is mostly defensive against
  // a future setup where the assets ship from a CDN).
  useEffect(() => {
    imagePaths.forEach((src) => {
      const img = new Image();
      img.src = src;
    });
  }, [imagePaths]);

  useEffect(() => {
    if (imagePaths.length <= 1) return;

    const timer = window.setInterval(() => {
      const prevIdx = currentIndexRef.current;
      setPreviousIndex(prevIdx);
      setIsTransitioning(true);
      setFadeOutComplete(false);

      let nextIdx: number;
      do {
        nextIdx = Math.floor(Math.random() * imagePaths.length);
      } while (nextIdx === prevIdx);
      setCurrentIndex(nextIdx);

      // Trigger the outgoing image's fade-out after a short
      // delay so both layers briefly overlap. Matches the
      // desktop carousel's "premium" overlap timing.
      const overlapDelay = Math.min(fadeInDuration * 0.4, fadeOutDuration * 2);
      window.setTimeout(() => setFadeOutComplete(true), overlapDelay);

      window.setTimeout(() => {
        setIsTransitioning(false);
        setPreviousIndex(null);
        setFadeOutComplete(false);
      }, Math.max(fadeInDuration, fadeOutDuration));
    }, interval);

    return () => window.clearInterval(timer);
  }, [imagePaths.length, interval, fadeInDuration, fadeOutDuration]);

  // Resolve the vertical anchor to CSS values.
  let topValue: number | string;
  let transformY: string;
  if (verticalAlign === 'top') {
    topValue = 0;
    transformY = '0';
  } else if (verticalAlign === 'bottom') {
    topValue = '100%';
    transformY = '-100%';
  } else if (typeof verticalAlign === 'string' && verticalAlign.includes('%')) {
    topValue = verticalAlign;
    transformY = '-50%';
  } else {
    topValue = '50%';
    transformY = '-50%';
  }

  if (imagePaths.length === 0) {
    // Empty container so the host's sized box still occupies its
    // slot in the layout while there's nothing to show.
    return <Box sx={{ width: '100%', height: '100%', ...(sx as object) }} />;
  }

  return (
    <Box
      sx={{
        position: 'relative',
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // Clip the `scale > 1` overflow so the carousel reads as
        // a tightly framed hero. The parent IntroPanel box also
        // applies its own `overflow: hidden`, this is belt &
        // suspenders.
        overflow: 'hidden',
        ...(sx as object),
      }}
    >
      {imagePaths.map((src, index) => {
        const isActive = index === currentIndex;
        const isPrevious = index === previousIndex && isTransitioning;

        let opacity = 0;
        let transition = 'none';

        if (isActive) {
          opacity = baseOpacity;
          transition = `opacity ${fadeInDuration}ms cubic-bezier(0.4, 0, 0.2, 1)`;
        } else if (isPrevious) {
          opacity = fadeOutComplete ? 0 : baseOpacity;
          transition = `opacity ${fadeOutDuration}ms cubic-bezier(0.4, 0, 1, 1)`;
        }

        return (
          <Box
            key={`${src}-${index}`}
            component="img"
            src={src}
            alt=""
            aria-hidden
            sx={{
              position: 'absolute',
              left: '50%',
              top: topValue,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              objectPosition: 'center top',
              opacity,
              // Combined translate (centring) + scale (zoom).
              // `transform: scale(zoom)` is the fluid-mode
              // equivalent of the desktop's `width = width * zoom`
              // pattern - works without a resolved pixel size.
              transform: `translate(-50%, ${transformY}) scale(${zoom})`,
              transition,
              pointerEvents: 'none',
              zIndex: isActive ? 2 : isPrevious ? 1 : 0,
              willChange: 'opacity',
              backfaceVisibility: 'hidden',
              WebkitBackfaceVisibility: 'hidden',
            }}
          />
        );
      })}
    </Box>
  );
}
