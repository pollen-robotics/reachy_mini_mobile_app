/**
 * Reachy Mini · session engine.
 *
 * Owns the robot TRANSPORT lifecycle end to end: SDK bootstrap, HF
 * central connect, WebRTC session bring-up (with retry), wake-up,
 * release / reacquire for iframe handoffs, and full teardown. The
 * host consumes it through `useRobotSession`.
 *
 * History note: this used to be the phone-side *conversation* engine
 * (HF realtime bridge, motion stack, tools, vision, audio monitors).
 * The conversation now runs ON THE ROBOT (the daemon launches the
 * conversation app; the phone drives it over JSON-RPC on the
 * DataChannel — see `features/conv-app`), so everything AI-related
 * was deleted and only the transport orchestration remains.
 *
 * Layout
 * ──────
 *   session-engine.ts        this file: options normalisation, core
 *                            state, controller wiring, handle build.
 *   connection-controller.ts the transport layer (boot → connect →
 *                            start → live, teardown, fatal errors).
 *   host-handle.ts           the public handle returned to the host.
 *   engine-core/             connection FSM + gates.
 *   ../RobotSession.ts       the session layer under the controller
 *                            (SDK ref, retry, wake/sleep, video,
 *                            transport monitor).
 */

// Side-effect import: attaches the bundled SDK to `window.ReachyMini`
// and dispatches `reachymini:ready` so the engine's CDN-style waiter
// (`whenReachyReady()`) resolves immediately. Without this the engine
// sits forever in `connecting`, waiting for a global that no <script>
// tag will ever set in the bundled mobile build.
import '@/features/robot-session/sdk-bootstrap';

import { RobotSession } from '@/features/robot-session/RobotSession';
import type { TransportInfo } from '@/features/robot-session/transport-monitor';
import { createEngineCore } from './engine-core';
import { createSessionHandle } from './host-handle';
import { createConnectionController, type ConnectionController } from './connection-controller';
import type {
  ConnectionAttempt,
  ConnectionState,
  SessionEngineHandle,
  SessionEngineOptions,
} from './types';

// Public-types re-exports so hosts can pull everything from one path.
export type {
  ConnectionAttempt,
  ConnectionState,
  SessionEngineHandle,
  SessionEngineOptions,
} from './types';

/**
 * Bootstrap the session engine. Returns the handle the React host
 * drives; dispose with `handle.unmount()`.
 */
export function mountSessionEngine(options: SessionEngineOptions = {}): SessionEngineHandle {
  // Mobile fast path: the host already knows which robot to talk to.
  const preselectedRobotId: string | null =
    typeof options.preselectedRobotId === 'string' && options.preselectedRobotId.length > 0
      ? options.preselectedRobotId
      : null;

  const onConnectionStateChange: ((state: ConnectionState) => void) | null =
    typeof options.onConnectionStateChange === 'function' ? options.onConnectionStateChange : null;

  const onTransportChange: ((info: TransportInfo) => void) | null =
    typeof options.onTransportChange === 'function' ? options.onTransportChange : null;

  const onErrorMessageChange: ((message: string | null) => void) | null =
    typeof options.onErrorMessageChange === 'function' ? options.onErrorMessageChange : null;

  const onConnectionAttempt: ((info: ConnectionAttempt | null) => void) | null =
    typeof options.onConnectionAttempt === 'function' ? options.onConnectionAttempt : null;

  const onDaemonVersionChange: ((version: string | null) => void) | null =
    typeof options.onDaemonVersionChange === 'function' ? options.onDaemonVersionChange : null;

  const emitDaemonVersion = (version: string | null): void => {
    if (!onDaemonVersionChange) return;
    try {
      onDaemonVersionChange(version);
    } catch (err) {
      console.warn('[session-engine] onDaemonVersionChange threw:', err);
    }
  };

  const emitConnectionAttempt = (info: ConnectionAttempt | null): void => {
    if (!onConnectionAttempt) return;
    try {
      onConnectionAttempt(info);
    } catch (err) {
      console.warn('[session-engine] onConnectionAttempt threw:', err);
    }
  };

  function emitErrorMessage(message: string | null): void {
    if (!onErrorMessageChange) return;
    try {
      onErrorMessageChange(message);
    } catch (err) {
      console.warn('[session-engine] onErrorMessageChange threw:', err);
    }
  }

  // ─── Engine core (shared mutable state) ───────────────────────────
  //
  // Initial FSM state: mobile-app fast path. HF auth is gated upstream
  // by `RemoteSignInScreen`, so by the time the engine boots the token
  // is already in `sessionStorage`. Start in `connecting` (spinner, no
  // caption flash) so the user never sees the misleading `signed-out`
  // intro.
  const core = createEngineCore({ initialConnectionState: 'connecting' });
  const { connection } = core;

  // ─── FSM subscribers ───────────────────────────────────────────────

  // 1. Host-facing state observer (React shell, watchdog timers).
  if (onConnectionStateChange) {
    connection.subscribe(next => {
      try {
        onConnectionStateChange(next);
      } catch (err) {
        console.warn('[session-engine] onConnectionStateChange threw:', err);
      }
    });
  }

  // 2. Error-message clearing on leave-error: the host renders a small
  //    caption when in `error`; drop it as soon as the user navigates
  //    away (e.g. tapping retry takes us back to `authenticated`).
  if (onErrorMessageChange) {
    connection.subscribe((next, prev) => {
      if (prev !== 'error' || next === 'error') return;
      try {
        onErrorMessageChange(null);
      } catch (err) {
        console.warn('[session-engine] onErrorMessageChange threw:', err);
      }
    });
  }

  // ─── Session layer ─────────────────────────────────────────────────
  // Owns the session-level state vars (sessionEstablished,
  // lastSetMotorMode), the stop-intent guard, the video stream cache
  // and the WebRTC transport monitor.
  const session = new RobotSession();
  session.setTransportListener(onTransportChange);

  // ─── Connection controller (transport layer) ───────────────────────
  const connectionController: ConnectionController = createConnectionController({
    core,
    session,
    preselectedRobotId,
    shouldDeferInitialWakeUp: options.shouldDeferInitialWakeUp,
    emitConnectionAttempt,
    emitErrorMessage,
    emitDaemonVersion,
  });

  // Fan the initial FSM value out to every subscriber (the FSM only
  // notifies on `set()`), so the host's watchdogs arm right at mount
  // instead of waiting for `boot()`'s first explicit transition.
  connection.set(connection.current());

  // Kick the boot chain and install background-tab resilience.
  const { bootChain, disposeBackgroundResilience } = connectionController.start();

  return createSessionHandle({
    getRobot: connectionController.getRobot,
    clearRobot: connectionController.clearRobot,
    session,
    isUnmounted: core.gates.unmounted.get,
    markUnmounted: core.gates.unmounted.on,
    bootChain,
    disposeBackgroundResilience,
    teardown: connectionController.teardown,
    setConnectionState: connection.set,
    emitConnectionAttempt,
    onFatalError: connectionController.onFatalError,
  });
}
