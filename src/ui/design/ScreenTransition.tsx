/**
 * Animated screen swap powered by Motion's `AnimatePresence`.
 *
 * The host (`App.tsx`) computes which screen should be on top
 * (`scan`, `session`, …) and feeds the corresponding
 * element + a stable `screenKey`. We orchestrate the cross-fade +
 * subtle vertical lift between them so navigation feels physical
 * instead of a hard cut.
 *
 * Why Motion over MUI's built-in transitions
 * ──────────────────────────────────────────
 * `AnimatePresence` is the only ergonomic way in React 19 to
 * animate a component on UNMOUNT (the React lifecycle removes the
 * node before MUI's `Fade`/`Slide` can react). Motion v12 also
 * runs animations through the native Web Animations API
 * (hardware-accelerated) and falls back to the View Transitions
 * API where supported - so we get 120fps performance on iOS
 * Safari 18+ / modern Android WebView for free, without writing
 * any platform-specific code.
 *
 * Why `mode="wait"` here
 * ──────────────────────
 * The two screens never overlap. The outgoing screen finishes its
 * exit animation BEFORE the incoming one mounts. That avoids:
 *   - double-mounting cost (query subscriptions, WebRTC engines)
 *     when transitioning between heavy screens
 *   - z-index headaches (no need for absolute positioning math)
 * The trade-off is a slightly longer perceived navigation - we
 * compensate with a snappy 0.22 s duration so it still feels
 * instantaneous.
 */
import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';

interface ScreenTransitionProps {
  /** Identifies the active screen. Changing it triggers an animated swap. */
  screenKey: string;
  children: ReactNode;
}

/**
 * Material-ish standard easing curve. Mirrors MUI's
 * `transitions.easing.easeInOut`, so the new animation feels in
 * the same family as the rest of the app's micro-interactions.
 */
const EASE = [0.4, 0, 0.2, 1] as const;
const DURATION_S = 0.22;

export default function ScreenTransition({
  screenKey,
  children,
}: ScreenTransitionProps) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={screenKey}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: DURATION_S, ease: EASE }}
        style={{
          height: '100%',
          width: '100%',
          // Force a stacking context so the outgoing screen
          // doesn't bleed transforms into the incoming one's
          // children mid-swap.
          position: 'relative',
        }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
