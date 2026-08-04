/**
 * Centralised timing budgets for the connect / handoff / teardown path.
 *
 * Every constant here pilots a step of the parcours that takes the user
 * from `ScanScreen` → live conversation → open app → close app → back
 * to conversation → power off. Keeping them in a single file means a
 * single open-file is enough to audit "how long can the user wait at
 * the worst" or to retune a budget without grepping across the engine,
 * the session helpers, and the iframe overlay.
 *
 * Scope on purpose
 * ────────────────
 * Only the timings that touch the session lifecycle live here. UI
 * micro-delays (toast min-display, slow-hint reveal, etc.) stay
 * co-located with the component that owns them - they are about
 * perception, not session-state machinery, and centralising them
 * would dilute the signal of this file.
 *
 * Read also
 * ─────────
 *   - `features/robot-session/start-session.ts`     uses SESSION_TIMINGS.start*
 *   - `features/conversation/engine/conversation-engine.ts`
 *                                                   uses SESSION_TIMINGS.glide* / bootChainUnmount*
 *   - `ui/panels/apps-list/AppIframeOverlay.tsx`    uses APP_HANDOFF_TIMINGS.*
 */

/**
 * Budgets governing the WebRTC session bring-up + tear-down.
 *
 * Worst-case bring-up latency before a fatal error is surfaced:
 *
 *     startAttemptTimeoutMs = 8_000 ms
 *
 * `startSession()` runs a SINGLE guarded attempt (no retry). The
 * previous 2-attempt / 12 s-gap loop was removed: it only ever
 * retried the SAME stale peer id, so it never recovered anything and
 * just made the user wait ~28 s. The live peer id is now re-resolved
 * from central right before the attempt (`RobotSession.start()`), and
 * genuine transport drops are handled by the connection controller's
 * background-resilience re-arm.
 *
 * Plus the wake-up trajectory (~2 s on a healthy robot), which is
 * bounded inside the SDK and not represented here.
 */
export const SESSION_TIMINGS = {
  /**
   * Timeout for the single `robot.startSession()` attempt. Healthy LAN
   * handshakes complete in 1-3 s; 8 s is a generous upper bound that
   * detects the silent daemon death without holding the user hostage.
   */
  startAttemptTimeoutMs: 8_000,

  /**
   * Duration of the smooth ease-out from the wobbler / antennas last
   * animated pose back to neutral when the user stops the
   * conversation (or hands off to an iframe). Long enough to feel
   * intentional, short enough that the post-stop motor-mode switch
   * lands within a second of the tap. 700 ms ≈ 21 frames at the
   * wobbler's 30 Hz stream rate, well above the perception threshold
   * for "abrupt".
   */
  glideToNeutralMs: 700,

  /**
   * Upper bound the `unmount()` handler waits for the in-flight boot
   * chain (`whenReachyReady → boot → doConnect → doStart`) to settle
   * before running `teardown()`. The boot chain has its own 8 s
   * per-attempt timeout inside `doStart`; this is the defensive
   * escape hatch so a tap on Back / power-off feels instantaneous
   * even when the chain itself is stuck.
   */
  bootChainUnmountTimeoutMs: 6_000,
} as const;

/**
 * Budgets governing the iframe handoff sequence (open app → close app).
 *
 * The two top-level timeouts (`iframeLoad*`, `embedConnect*`) split
 * the embed boot into two phases with very different expected
 * durations:
 *
 *   - `iframeLoad`     HF Space cold-start (network + container
 *                      spin-up + bundle parse).
 *   - `embedConnect`   `connectToHost()` resolving (host:init +
 *                      WebRTC handshake + ensureAwake motion).
 *
 * Once either elapses we surface a "didn't load" card with a
 * single "back to catalog" CTA.
 */
export const APP_HANDOFF_TIMINGS = {
  /**
   * Hard timeout for the iframe load step (HTML + JS bundle parsed).
   * 15 s is generous for a cold HF Space; anything past that is a
   * real failure cue.
   */
  iframeLoadTimeoutMs: 15_000,

  /**
   * Hard timeout for the embed boot step (`onLoad` fired but the
   * embed hasn't reached `phase: 'live'`). Covers `connectToHost()`'s
   * wait for `host:init`, the WebRTC handshake, and the wake-up
   * motion - so it has to be longer than just the iframe load
   * (cold-starting an HF Space + ICE negotiation + initial
   * trajectory all stack up).
   */
  embedConnectTimeoutMs: 20_000,

  /**
   * "Closing $appName…" beat played by `AppIframeOverlay` between
   * the user's tap on ✕ and the parent's `setOpenedApp(null)`. The
   * intermediate beat avoids the jarring "press × → screen vanishes
   * mid-frame" effect and overlaps with the upstream
   * `session.reacquire()` latency (~300-800 ms) so the close feels
   * snappy without skipping a frame on the way back.
   */
  closingBeatMs: 1_000,

  /**
   * Legacy hash-only embed reveal fallback. If after this much time
   * inside the `connecting` phase the iframe hasn't posted a single
   * protocol-v1 envelope, we conclude it's a non-protocol embed and
   * reveal it immediately rather than holding the spinner for the
   * full `embedConnectTimeoutMs`. Long enough that a modern app's
   * `embed:ready` always lands first, short enough that legacy apps
   * don't sit behind the overlay long enough to read as broken.
   */
  legacyEmbedRevealMs: 1_500,
} as const;
