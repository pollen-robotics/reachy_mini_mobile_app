/**
 * Shared design tokens for the mobile app.
 *
 * Pared-down version of the desktop `@styles` module: only the primitives we
 * actually rely on in the redesigned screens, kept framework-agnostic so they
 * can be passed into MUI `sx` or raw CSS.
 *
 * Typography & radius scales mirror the desktop for visual kinship; colour
 * tokens rely on MUI's palette at call sites rather than being frozen here.
 */

export const TYPO = {
  // New floor of the scale. Introduced for "kicker" labels that
  // live INSIDE a chip / pill (cf. `HfAccountBar`'s "SIGNED IN
  // AS" sub-label) where even `micro` reads too loud next to the
  // content it's framing. Don't use `nano` for free-standing
  // labels above a card - those should stay at `tiny` to keep
  // matching `Section`'s canonical header style.
  nano: '0.6rem',
  micro: '0.65rem',
  tiny: '0.7rem',
  xs: '0.75rem',
  sm: '0.8rem',
  body: '0.85rem',
  md: '0.9rem',
  lg: '1rem',
  xl: '1.1rem',
  xxl: '1.25rem',
  hero: '1.5rem',
  display: '1.625rem',
} as const;

export const FONT_WEIGHT = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const;

export const RADIUS = {
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  xxl: 20,
  pill: 9999,
  circle: '50%',
} as const;

export const STATUS = {
  success: '#22c55e',
  successSoft: '#16a34a',
  error: '#ef4444',
  warning: '#f59e0b',
  info: '#6366f1',
} as const;

export const DURATION = {
  fast: 150,
  base: 250,
  slow: 400,
} as const;

/**
 * Max width used by all centred "card-in-screen" layouts (scan, transition).
 * Matches the desktop's 420px content card width.
 */
export const LAYOUT = {
  contentMaxWidth: 420,
  heroSize: 160,
  heroSizeSmall: 120,
  /**
   * Top padding that respects the OS-reported safe area (notch / status
   * bar). Resolves to the actual inset on iOS (notch devices ~44-50px,
   * non-notch ~20px), and the system-bars + cutout union on Android
   * via the `--inset-*` CSS variables set by `shared/android-insets.ts`
   * from the host activity's `WindowInsets` (the native half is patched
   * into the generated MainActivity by `scripts/patch-android-insets.py`,
   * which CI runs after `tauri android init`). Falls back to `env()`
   * (works on iOS) and then `0px` on platforms where neither is set
   * (Tauri desktop, plain web).
   *
   * Plumbed through MUI `sx` as a raw CSS string, which `pt`/`py`
   * accept verbatim. `viewport-fit=cover` is set in `index.html`, which
   * is required for iOS to expose `env(safe-area-inset-top)`.
   */
  safeAreaTop: 'var(--inset-top, env(safe-area-inset-top, 0px))',
  /**
   * Bottom equivalent. Critical on Android 15+ where edge-to-edge is
   * enforced (and the generated MainActivity calls `enableEdgeToEdge()`
   * on every Android version): without the injected `--inset-bottom`
   * the 3-button nav bar / gesture indicator overlaps the
   * `BottomNavigation`.
   */
  safeAreaBottom: 'var(--inset-bottom, env(safe-area-inset-bottom, 0px))',
} as const;
