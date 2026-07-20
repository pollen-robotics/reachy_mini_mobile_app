/**
 * Boolean gate primitive.
 *
 * Replaces the dozen scattered `let` boolean variables (`unmounted`,
 * `conversationStarted`, `convoActiveRequested`, `movePlaying`, …)
 * the conversation engine used to keep inside a single giant
 * closure. Each gate is a small explicit object with `get / set /
 * on / off`, so:
 *
 *   - The state is grep-able by name (`gates.convoActiveRequested`
 *     instead of a closure-private `let`).
 *   - Sub-systems can be handed exactly the gate they need without
 *     the rest of the closure tagging along.
 *   - Tests can stub a gate with a fixed value without spinning up
 *     the whole engine.
 *
 * Intentionally minimal: no subscribers, no validation, no async.
 * If a piece of state needs observers, use the `Fsm` primitive
 * next door instead.
 */

export interface Gate {
  /** Current value. */
  get(): boolean;
  /** Set the value (no observer fan-out). */
  set(value: boolean): void;
  /** Shortcut for `set(true)`. */
  on(): void;
  /** Shortcut for `set(false)`. */
  off(): void;
}

export function makeGate(initial: boolean): Gate {
  let value = initial;
  return {
    get: () => value,
    set: v => {
      value = v;
    },
    on: () => {
      value = true;
    },
    off: () => {
      value = false;
    },
  };
}
