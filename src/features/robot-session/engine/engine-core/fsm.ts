/**
 * Generic finite-state-machine primitive.
 *
 * Replaces the conversation engine's `let currentState: AppState`
 * + freestanding `setState()` pair with an explicit object that
 * owns the cursor AND fans transitions out to any number of
 * subscribers. Each side-effect that used to live inline inside
 * `setState()` (host `onStateChange` observer, error-message
 * clearing on leave-error, motor-mode sync on enter-active) is now
 * a separate subscriber registered at mount time.
 *
 * Why
 * ───
 * - The FSM module stays pure: it doesn't know about robots,
 *   observers, or motor modes. Plain `(T) => void` callbacks.
 * - Side effects become greppable. Today you read
 *   `setState("ai-speaking")` and have to remember it also kicks
 *   the motor mode and clears the error message. With subscribers
 *   each effect lives in its own named function, registered once,
 *   visible at engine bring-up.
 * - Trivially unit-testable. `createFsm("a").set("b")` exercises
 *   the entire transition machinery without a single import.
 *
 * Semantics
 * ─────────
 * - `set(next)` always flips the cursor (no equality short-circuit).
 *   That matches the engine's pre-extraction behaviour: a redundant
 *   `setState("ready")` still triggered the side effects.
 * - Subscribers fire synchronously in registration order, with both
 *   `next` and `prev` values; the cursor is already updated when
 *   they run, so `fsm.current() === next` inside.
 * - A throwing subscriber is caught and logged so a broken host
 *   callback can't take the whole transition down.
 */

export interface Fsm<T> {
  /** Read the live cursor. */
  current(): T;
  /** Flip the cursor and fan the transition out to every subscriber
   *  in registration order. Always fires, even on a no-op
   *  transition (`set(current())`). */
  set(next: T): void;
  /** Register a transition listener. Returns an unsubscribe
   *  function. The listener runs after the cursor has been
   *  updated, so it can read `fsm.current()` as the new state. */
  subscribe(listener: (next: T, prev: T) => void): () => void;
}

export interface CreateFsmOptions {
  /** Diagnostic label prefixed to the per-transition console.log.
   *  Set to `null` to silence (tests / hot paths). */
  label?: string | null;
}

export function createFsm<T>(initial: T, options: CreateFsmOptions = {}): Fsm<T> {
  const label = options.label === undefined ? 'fsm' : options.label;
  let cursor: T = initial;
  const listeners = new Set<(next: T, prev: T) => void>();

  return {
    current: () => cursor,
    set: next => {
      const prev = cursor;
      if (label !== null) {
        console.log(`[${label}] ${String(prev)} -> ${String(next)}`);
      }
      cursor = next;
      for (const listener of listeners) {
        try {
          listener(next, prev);
        } catch (err) {
          console.warn(
            `[${label ?? 'fsm'}] subscriber threw on ${String(prev)} -> ${String(next)}:`,
            err
          );
        }
      }
    },
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
