/**
 * Defer mounting a subtree until it scrolls near the viewport.
 *
 * The Apps tab stacks many horizontal rails vertically. Only two or
 * three are ever on screen, yet each rail mounts a row of
 * `AppCompactTile`s and every tile spins up its own TanStack
 * like-observer + icon load. With a 200-300 app catalog that is a lot
 * of work done up-front for rows the user may never scroll to.
 *
 * `LazyMount` reserves the rail's vertical space with a lightweight
 * placeholder, watches it with an `IntersectionObserver`, and swaps in
 * the real children the moment the placeholder enters the (generously
 * margined) viewport. Once mounted it STAYS mounted - scrolling a rail
 * back out of view keeps its tiles alive so a scroll-up is instant and
 * we never thrash the like-observers. This is intentionally simpler
 * than a true windowing virtualiser: rails are few and cheap once
 * capped, the only win we need is "don't build the ones nobody sees".
 *
 * The placeholder's `minHeight` should approximate the mounted height
 * so the scrollbar doesn't lurch when content swaps in. Because we
 * mount ahead of the fold (`rootMargin`), any small mismatch resolves
 * off-screen and is invisible.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Box } from '@mui/material';

interface LazyMountProps {
  /**
   * Height reserved by the placeholder before the children mount,
   * in pixels. Pick a value close to the real mounted height so the
   * scroll position stays stable as rails hydrate.
   */
  minHeight: number;
  /**
   * How far outside the viewport the trigger fires, as an
   * `IntersectionObserver` `rootMargin`. A large vertical margin
   * mounts rails before they're actually visible so the user never
   * catches one mid-hydration during a normal scroll.
   */
  rootMargin?: string;
  children: ReactNode;
}

export default function LazyMount({
  minHeight,
  rootMargin = '800px 0px',
  children,
}: LazyMountProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (shown) return;
    const el = ref.current;
    if (!el) return;

    // Environments without IntersectionObserver (very old webviews,
    // SSR/jsdom) get the children immediately rather than a permanent
    // placeholder - degrade to the pre-LazyMount behaviour.
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }

    const io = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown, rootMargin]);

  return (
    <Box ref={ref} sx={shown ? undefined : { minHeight }}>
      {shown ? children : null}
    </Box>
  );
}
