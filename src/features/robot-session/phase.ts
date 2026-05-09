/**
 * Pure phase derivation for the robot session.
 *
 * Lives in its own module so unit tests can import `derivePhase`
 * without pulling in the conversation engine (which runs SDK
 * bootstrap code, references the central signaling URL, and
 * generally only makes sense in a Tauri WebView).
 *
 * The runtime hook (`useRobotSession`) re-exports `SessionPhase`
 * and `derivePhase` from here so existing imports keep working.
 */

import type { AppState } from '@/features/conversation/engine/types';

/**
 * High-level session phase observed by the host. Derived from the
 * engine's `AppState` plus the in-flight handoff transitions that
 * the engine doesn't track itself.
 */
export type SessionPhase =
  /** No engine yet (initial render, or after teardown). */
  | 'idle'
  /** Engine is bringing the SDK / WebRTC / wake-up dance up. */
  | 'bringing-up'
  /** Engine is up; robot is physically online. May or may not be
   *  in a live conversation. */
  | 'live'
  /** Engine is mid-handoff: WebRTC session is being released. */
  | 'releasing'
  /** Session was deliberately released; robot is still awake;
   *  iframe (or another consumer) holds the producer slot. */
  | 'released'
  /** Engine is bringing the WebRTC session back after a release. */
  | 'reacquiring'
  /** Full teardown is in flight (sleep + disable + stopSession +
   *  disconnect). */
  | 'tearing-down'
  /** Engine surfaced a fatal error. */
  | 'error';

/**
 * Map an engine `AppState` to the host-facing session phase, given
 * a `phaseHint` that captures the in-flight handoff transitions
 * (which the engine itself doesn't track).
 *
 * The hint takes precedence over the engine state EXCEPT for the
 * `'idle'` value, which is the post-teardown reset and lets the
 * engine drive the UI again on the next mount.
 */
export function derivePhase(
  engineState: AppState,
  phaseHint: SessionPhase | null,
): SessionPhase {
  if (phaseHint && phaseHint !== 'idle') return phaseHint;
  switch (engineState) {
    case 'signed-out':
    case 'authenticated':
    case 'connecting':
    case 'connected':
    case 'auto-selecting':
    case 'starting':
      return 'bringing-up';
    case 'ready':
    case 'listening':
    case 'user-speaking':
    case 'processing':
    case 'ai-speaking':
      return 'live';
    case 'released':
      return 'released';
    case 'error':
      return 'error';
    default:
      return 'bringing-up';
  }
}
