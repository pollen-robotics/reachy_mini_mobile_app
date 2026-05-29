/**
 * Engine-wide shared state container.
 *
 * Replaces the bag of `let` variables that used to live at the
 * top of `mountConversation()` with one explicit object. Every
 * sub-system that needs to coordinate with the rest of the engine
 * reads / writes through `EngineCore`, instead of capturing a
 * closure-local mutable variable. The benefits:
 *
 *   - Grep-ability: `core.gates.conversationStarted` always points
 *     at the same state, no matter which sub-module is reading it.
 *   - Slice-ability: a sub-system can be handed `core.fsm` +
 *     `core.gates.movePlaying` only, without dragging the rest of
 *     the engine into its dep shape.
 *   - Test-ability: `createEngineCore({...})` can be instantiated
 *     in a test without an SDK, an OpenAI key, or a DOM.
 *
 * What lives here vs elsewhere
 * ────────────────────────────
 * - `fsm`               : the engine's state machine. Side effects
 *                         (host observer, error clearing, motor
 *                         mode sync) are registered as subscribers
 *                         at mount time; the FSM itself stays pure.
 * - `gates`             : the boolean flags that gate cross-system
 *                         decisions (`unmounted`, `conversationStarted`,
 *                         `convoActiveRequested`, `movePlaying`).
 *
 * Intentionally NOT here:
 *   - `robot`           : the SDK ref. Lives in `RobotSession`; the
 *                         engine reads it via `session.getRobot()`.
 *   - audio levels       : cached inside `audio-monitors-control`.
 *   - motor mode dedup   : cached inside `RobotSession`.
 *   - observers          : closure-captured option callbacks. They
 *                         could move here later if any sub-system
 *                         outside `mountConversation` needs them
 *                         directly.
 *
 * Adding new state: ask first whether the new piece is truly
 * engine-wide. If it's only read by one sub-system, keep it inside
 * that sub-system. `EngineCore` is for state that ≥ 2 sub-systems
 * need to coordinate on.
 */

import type { AppState } from "../types";
import { type Fsm, createFsm } from "./fsm";
import { type Gate, makeGate } from "./gate";

export type { Fsm } from "./fsm";
export type { Gate } from "./gate";

export interface EngineCoreGates {
  /** True once the conversation parts (antennas, OpenAI, wobbler)
   *  are running. Read by the host handle to short-circuit
   *  `startConversation()`, by `tearDownConversationPipeline()` to
   *  short-circuit when there's nothing to stop, and by the boot
   *  pipeline to avoid double-starts. */
  conversationStarted: Gate;
  /** True when the host has opted into running the conversation
   *  parts. Initial value comes from `options.autoStartConversation`.
   *  Flipped by `startConversation()` / `stopConversation()` on the
   *  handle, read by `doStart()` to decide whether to park in
   *  `ready` or fall through to `runConversationParts()`. */
  convoActiveRequested: Gate;
  /** Terminal flag flipped by `handle.unmount()`. Every async
   *  entrypoint short-circuits on this so a late effect (visibility
   *  resume, OpenAI reconnect, etc.) can't poke a torn-down engine. */
  unmounted: Gate;
  /** True while a tool-call choreography is playing. Read by the
   *  wobbler + antennas controllers so they yield their 30 Hz
   *  writes for the duration of the recorded frames (otherwise
   *  they'd fight the dance). */
  movePlaying: Gate;
}

export interface EngineCore {
  fsm: Fsm<AppState>;
  gates: EngineCoreGates;
}

export interface CreateEngineCoreOptions {
  /** Initial FSM state. The mobile app starts in `"connecting"` so
   *  the user doesn't see a flash of the `"signed-out"` intro
   *  (auth already happened upstream on `RemoteSignInScreen`). */
  initialState: AppState;
  /** Initial value for the `convoActiveRequested` gate. Defaults
   *  to `true` (Space-app behaviour: tap once → talking); the
   *  mobile shell passes `false` so the wake-up animation can
   *  play without the antennas / OpenAI firing in parallel. */
  convoActiveRequested: boolean;
  /** Diagnostic label prefixed to every FSM transition log. Pass
   *  `null` to silence (tests). */
  fsmLabel?: string | null;
}

export function createEngineCore(
  options: CreateEngineCoreOptions,
): EngineCore {
  return {
    fsm: createFsm<AppState>(options.initialState, {
      label: options.fsmLabel === undefined ? "engine" : options.fsmLabel,
    }),
    gates: {
      conversationStarted: makeGate(false),
      convoActiveRequested: makeGate(options.convoActiveRequested),
      unmounted: makeGate(false),
      movePlaying: makeGate(false),
    },
  };
}
