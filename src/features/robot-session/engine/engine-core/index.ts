/**
 * Engine-wide shared state container.
 *
 * Bundles the connection FSM cursor + the boolean gates the
 * sub-systems coordinate on, instead of a bag of closure-local `let`
 * variables. Each piece is explicit (greppable, sliceable, testable
 * in isolation).
 *
 * What lives here vs elsewhere
 * ────────────────────────────
 * - `connection`        : the transport state machine. Side effects
 *                         (host observer, error clearing, motor
 *                         mode sync) are registered as subscribers
 *                         at mount time; the FSM itself stays pure.
 * - `gates.unmounted`   : terminal flag flipped by `handle.unmount()`.
 *                         Every async entrypoint short-circuits on it
 *                         so a late effect can't poke a torn-down
 *                         engine.
 *
 * Intentionally NOT here:
 *   - `robot`           : the SDK ref. Lives in `RobotSession`; the
 *                         engine reads it via `session.getRobot()`.
 *   - motor mode dedup  : cached inside `RobotSession`.
 */

import type { ConnectionState } from '../types';
import { type Fsm, createFsm } from './fsm';
import { type Gate, makeGate } from './gate';

export type { Fsm } from './fsm';
export type { Gate } from './gate';

export interface EngineCoreGates {
  /** Terminal flag flipped by `handle.unmount()`. Every async
   *  entrypoint short-circuits on this so a late effect (visibility
   *  resume, reconnect, etc.) can't poke a torn-down engine. */
  unmounted: Gate;
}

export interface EngineCore {
  /** Transport / connection FSM (SDK + WebRTC + DataChannel link). */
  connection: Fsm<ConnectionState>;
  gates: EngineCoreGates;
}

export interface CreateEngineCoreOptions {
  /** Initial connection state. The mobile app starts in `"connecting"`
   *  so the user doesn't see a flash of the `"signed-out"` intro
   *  (auth already happened upstream on `RemoteSignInScreen`). */
  initialConnectionState: ConnectionState;
  /** Diagnostic label prefixed to every connection FSM transition
   *  log. Pass `null` to silence (tests). */
  connectionLabel?: string | null;
}

export function createEngineCore(options: CreateEngineCoreOptions): EngineCore {
  return {
    connection: createFsm<ConnectionState>(options.initialConnectionState, {
      label: options.connectionLabel === undefined ? 'connection' : options.connectionLabel,
    }),
    gates: {
      unmounted: makeGate(false),
    },
  };
}
