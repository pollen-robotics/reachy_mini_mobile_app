/**
 * Glue between the bundled SDK and the engine's CDN-style discovery.
 *
 * The conversation engine was originally written for the public
 * Hugging Face Space app, where the ReachyMini SDK was loaded via a
 * `<script type="module">` tag and a CDN dispatched a
 * `reachymini:ready` event when the global was wired up. The engine
 * waits on `window.ReachyMini` (or that event) inside `boot()` so it
 * doesn't try to construct an SDK instance before the script has
 * finished evaluating.
 *
 * The mobile app bundles the SDK directly via Vite (ES module import
 * from `@pollen-robotics/reachy-mini-sdk`). There is no `<script>`
 * tag, no external loader, and the global never gets set - which made
 * the engine sit forever in `connecting`, with no `wakeUp` ever firing.
 *
 * This file fixes that mismatch the surgical way: as soon as the
 * conversation module's engine code is loaded, we attach the bundled
 * `ReachyMini` to `window.ReachyMini` and dispatch the
 * `reachymini:ready` event the engine listens for. The engine then
 * proceeds through `whenReachyReady() → boot() → robot.authenticate()
 * → robot.connect() → startSession() → wakeUp()` exactly as designed.
 *
 * Module-level side effect on purpose: the engine pulls this file in
 * via a static import below, so the first time anything in
 * `src/conversation/` evaluates, the global is in place. Idempotent
 * (the assignment guards against double-set) so repeated imports are
 * a no-op.
 */
import { ReachyMini } from '@pollen-robotics/reachy-mini-sdk';

if (typeof window !== 'undefined') {
  // Type story: the engine's `globals.ts` augments `Window` with a
  // CDN-style `ReachyMini: ReachyMiniConstructor` declaration that
  // describes the engine's own internal SDK surface
  // (`ReachyMiniInstance` - includes `_pc`, `attachVideo`,
  // `setHeadRpyDeg`, `setMicMuted`, ...). The npm SDK's ambient
  // `.d.ts` (`src/types/reachy-mini-sdk.d.ts`) is a smaller, partial
  // surface (`robotState`, `setTarget`, `setHeadOrientation`, ...).
  // The two disagree on the type level even though at runtime the
  // bundled class implements every method either side names - the JS
  // source has both `setHeadRpyDeg` (engine-facing) and
  // `setHeadOrientation` (vendor-facing alias), `setMicMuted`, `_pc`,
  // etc.
  //
  // Reconciling the two via overlapping interfaces would force a
  // change to the ambient `.d.ts` (out of this module's scope) or
  // a duplicated declaration. We sidestep by going through
  // `unknown`: the assignment is correct at runtime, the cast just
  // tells TypeScript not to police the discrepancy.
  const w = window as Window;
  if (!w.ReachyMini) {
    w.ReachyMini = ReachyMini as unknown as typeof w.ReachyMini;
    // Engine's `whenReachyReady()` listens for this event when
    // `window.ReachyMini` was not yet defined at the time of its
    // first read. Dispatching it AFTER the assignment makes the
    // wait resolve immediately.
    try {
      window.dispatchEvent(new Event('reachymini:ready'));
    } catch (err) {
      console.warn('[conversation] failed to dispatch reachymini:ready:', err);
    }
  }
}
