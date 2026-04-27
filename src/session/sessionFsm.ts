/**
 * Session FSM - pure data layer for RobotSessionScreen.
 *
 * Why this file exists
 * ────────────────────
 * The screen used to manage `phase`, `activeStep` and `handshakeError`
 * as three independent `useState` hooks, sprinkled with "if phase ===
 * X" branches across half a dozen effects. That made it impossible to
 * answer simple questions ("can the user tap retry from 'live'?",
 * "what advances activeStep from 2 to 3?") without grepping. Reifying
 * the lifecycle here means:
 *
 *   - One place to read the legal transitions.
 *   - Illegal events become no-ops with a structured warning instead
 *     of silent state corruption.
 *   - The screen stays a thin renderer; `useSessionController` (next
 *     file) is the single owner of the wiring between FSM events and
 *     external hooks (motion store, engine, daemon probe).
 *
 * What this file is NOT
 * ─────────────────────
 * - Side effects (motion store flush, engine teardown, BLE
 *   disconnect): the controller subscribes to FSM transitions and
 *   runs them.
 * - The conversation engine `AppState`: that is downstream data and
 *   only matters in so far as it produces events here (e.g. "engine
 *   left transient" → no event, the screen handles substep ticks
 *   itself; "wake completed" → `engine.wake_completed`).
 * - The daemon probe (`useDaemonStatus`) state.
 * - `bleNetworkIp` / `peerId` / similar session-scoped values that
 *   never drive a transition once captured: the controller keeps
 *   those in plain state and reads the FSM phase to decide when to
 *   do work with them.
 *
 * Lifecycle phases
 * ────────────────
 *   handshake → engine → ready → live → leaving
 *
 *   handshake : BLE pairing / peer-id pre-checks. May fail and surface
 *               a `HandshakeError`; retry brings us back to a fresh
 *               handshake with a bumped `retryEpoch`.
 *   engine    : ConversePanel mounted, WebRTC DC negotiating, daemon
 *               probe coming up. Wake-up runs at the end of this
 *               phase; success transitions to `ready`, failure goes
 *               back to `handshake` with an error.
 *   ready     : Wake-up complete, robot is awake, motors online. The
 *               user has to tap "Start conversation" before audio /
 *               antennas / engine pipeline activate.
 *   live      : Conversation pipeline is running.
 *   leaving   : Back was tapped. Terminal from the FSM's POV - the
 *               controller fires graceful teardown and the parent
 *               unmounts us via `onBack()`.
 */
import type { CentralRobotEntry } from '../auth/fetchRobotsFromCentral';
import type { ReachyBleDevice } from '../ble/useBleSession';

// ─── Public types ────────────────────────────────────────────────────

/** What the user is connecting to. Constant for the lifetime of the screen.
 *
 * Three flavours, distinguished by how the user reached this screen:
 *
 *   - `local`     : tapped a BLE-advertised robot on the discovery list.
 *                   Address is the BLE plugin handle; the LAN IP is
 *                   discovered on the fly during the handshake.
 *   - `localhost` : tapped a row produced by `useLocalDaemonSource`
 *                   (a daemon answering on `127.0.0.1:8000` - typically
 *                   the tray app on the same Mac as the Tauri build).
 *                   The host is known up front so we skip BLE pairing
 *                   AND Wi-Fi onboarding entirely.
 *   - `remote`    : tapped a robot listed by the HF central source.
 *                   Reached purely through the WebRTC `http_proxy`.
 */
export type ConnectionTarget =
  | { kind: 'local'; device: ReachyBleDevice }
  | {
      kind: 'localhost';
      /** LAN host the daemon listens on. `127.0.0.1` for the tray case. */
      host: string;
      /** Daemon-reported robot name at discovery time. May still be the
       *  default `reachy_mini`; the session screen prompts for naming
       *  before going further when that's the case. */
      robotName: string;
    }
  | { kind: 'remote'; robot: CentralRobotEntry };

/**
 * Failure surface used by the handshake retry view AND the wake-up
 * failure surfacing path. The two cases reuse the same UI to keep the
 * "robot didn't come up" recovery affordance consistent.
 */
export interface HandshakeError {
  failedAt: number;
  title: string;
  body: string;
  detail: string | null;
  /** Local-only: offer the "Set up Wi-Fi" CTA instead of plain Retry. */
  offerWifiSetup: boolean;
}

/** Coarse session lifecycle phase. See header comment. */
export type SessionPhase =
  | 'handshake'
  | 'engine'
  | 'ready'
  | 'live'
  | 'leaving';

/**
 * Full FSM state. Surfaced as a single immutable value so consumers
 * can `useSyncExternalStore`-style subscribe to it without juggling
 * three correlated booleans.
 *
 * `retryEpoch` and `remountEpoch` are monotonic counters. They give
 * effects a stable handle to react to ("re-run handshake when
 * retryEpoch changes", "rebuild ConversePanel when remountEpoch
 * changes") without us having to expose intermediate booleans that
 * would need manual reset.
 */
export interface SessionFsmState {
  phase: SessionPhase;
  /** Index into the phase's step labels. Meaningful for handshake/engine. */
  activeStep: number;
  /** Set on handshake/wake failure, cleared on retry. */
  error: HandshakeError | null;
  /** Bumped on every retry. Effects key off this to re-run the handshake. */
  retryEpoch: number;
  /** Bumped on relay heal. ConversePanel keys off this to remount. */
  remountEpoch: number;
}

// ─── Events ──────────────────────────────────────────────────────────

/**
 * Discriminated union of every event the FSM understands. Events are
 * the *only* mutation surface (useReducer-style). Adding a new
 * lifecycle moment means: add a kind here, add the case in
 * `reduceSession`, document any back-edge in the header.
 *
 * All payloads are plain data - no functions, no class instances - so
 * the action stream is greppable and could be replayed for tests.
 */
export type SessionEvent =
  /** Handshake substep advanced (BLE done, NETWORK_STATUS read, …). */
  | { kind: 'handshake.step'; step: number }
  /** Handshake failed (BLE timeout, missing peer id, no Wi-Fi, …). */
  | { kind: 'handshake.failed'; error: HandshakeError }
  /**
   * Pre-engine checks done (BLE up + IP captured, or peer id valid).
   * Transitions to 'engine' and snaps activeStep to 2 to match the
   * stepper labels (LOCAL: Bluetooth, Network, Daemon, Wake up).
   */
  | { kind: 'handshake.bridged' }
  /**
   * First daemon probe landed OK over the WebRTC proxy. Advances
   * substep within engine. Wake-up runs separately and emits its own
   * event when done.
   */
  | { kind: 'engine.tunnel_ready' }
  /** wake_up flushed cleanly (motion outcome `completed` | `idle`). */
  | { kind: 'engine.wake_completed'; totalSteps: number }
  /**
   * wake_up flushed with a recoverable error (bus stuck, transport
   * down, generic move failure). Surfaces back to handshake with an
   * error so the user can retry from the same Failure view.
   */
  | { kind: 'engine.wake_failed'; error: HandshakeError }
  /** User tapped "Start conversation" in 'ready'. */
  | { kind: 'live.requested' }
  /** User tapped Back. */
  | { kind: 'leave.requested' }
  /** User tapped Retry on the failure view. Resets to a fresh handshake. */
  | { kind: 'retry.requested' }
  /**
   * Daemon ↔ central relay was healed. Bumps `remountEpoch` so
   * ConversePanel rebuilds on the now-healthy relay. Allowed from
   * engine/ready/live; ignored otherwise (heal can't run during
   * handshake or after leave).
   */
  | { kind: 'engine.relay_healed' };

/** All event kinds, useful for type-narrowing in selectors. */
export type SessionEventKind = SessionEvent['kind'];

// ─── Initial state ───────────────────────────────────────────────────

export const INITIAL_SESSION_STATE: SessionFsmState = {
  phase: 'handshake',
  activeStep: 0,
  error: null,
  retryEpoch: 0,
  remountEpoch: 0,
};

// ─── Transition function ─────────────────────────────────────────────

/**
 * Pure transition. Illegal events (an event that doesn't apply to
 * the current phase) return the previous state unchanged. The
 * controller is encouraged to feed every (prev, event, next) triple
 * through `describeIllegalTransition` so we get a structured log
 * line for stuck transitions during dev.
 *
 * Legal transition table (mirror of the event docstrings):
 *
 *   handshake → handshake : .step  / .failed / .retry
 *   handshake → engine    : .bridged (only if no error)
 *   engine    → engine    : .tunnel_ready / .relay_healed
 *   engine    → ready     : .wake_completed
 *   engine    → handshake : .wake_failed (failure replays as HandshakeError)
 *   ready     → live      : .live.requested
 *   ready     → leaving   : .leave.requested
 *   live      → leaving   : .leave.requested
 *   handshake → leaving   : .leave.requested (Back during handshake)
 *   any       → handshake : .retry.requested (resets activeStep + error)
 *
 * `leaving` is terminal: no event takes us out of it. The parent
 * unmounts the screen via its `onBack()` callback once the
 * controller's teardown side-effect resolves.
 */
export function reduceSession(
  prev: SessionFsmState,
  event: SessionEvent,
): SessionFsmState {
  switch (event.kind) {
    case 'handshake.step': {
      if (prev.phase !== 'handshake') return prev;
      if (event.step <= prev.activeStep) return prev;
      return { ...prev, activeStep: event.step };
    }

    case 'handshake.failed': {
      if (prev.phase !== 'handshake') return prev;
      return { ...prev, error: event.error };
    }

    case 'handshake.bridged': {
      if (prev.phase !== 'handshake') return prev;
      if (prev.error !== null) return prev;
      // activeStep snaps to 2 to match LOCAL_STEP_LABELS / REMOTE_STEP_LABELS
      // ("Daemon" or "WebRTC" - the penultimate step). Same value in both
      // modes, which is why the FSM doesn't need to know about the target.
      return { ...prev, phase: 'engine', activeStep: 2 };
    }

    case 'engine.tunnel_ready': {
      if (prev.phase !== 'engine') return prev;
      if (prev.activeStep >= 3) return prev;
      return { ...prev, activeStep: 3 };
    }

    case 'engine.wake_completed': {
      if (prev.phase !== 'engine') return prev;
      return {
        ...prev,
        phase: 'ready',
        activeStep: event.totalSteps,
        error: null,
      };
    }

    case 'engine.wake_failed': {
      if (prev.phase !== 'engine') return prev;
      // Surface the wake failure as a handshake error so the user
      // gets the same Retry CTA they'd see on a BLE-stage failure.
      // The retry runs the whole flow including a defensive bus
      // recycle (handled by motion store).
      return { ...prev, phase: 'handshake', error: event.error };
    }

    case 'live.requested': {
      if (prev.phase !== 'ready') return prev;
      return { ...prev, phase: 'live' };
    }

    case 'leave.requested': {
      if (prev.phase === 'leaving') return prev;
      return { ...prev, phase: 'leaving' };
    }

    case 'retry.requested': {
      // From any phase. Resets to a fresh handshake; preserves the
      // remountEpoch so an in-flight ConversePanel teardown caused by
      // a concurrent heal isn't fought.
      return {
        phase: 'handshake',
        activeStep: 0,
        error: null,
        retryEpoch: prev.retryEpoch + 1,
        remountEpoch: prev.remountEpoch,
      };
    }

    case 'engine.relay_healed': {
      if (prev.phase === 'handshake' || prev.phase === 'leaving') return prev;
      return { ...prev, remountEpoch: prev.remountEpoch + 1 };
    }

    default:
      return assertNever(event);
  }
}

function assertNever(value: never): never {
  // Intentional throw: this is reached only if a new SessionEvent kind
  // was added without a corresponding case above. The TS exhaustiveness
  // check should catch it at compile time; runtime throw is a safety net.
  throw new Error(
    `Unhandled SessionEvent kind: ${JSON.stringify(value)}`,
  );
}

// ─── Selectors ───────────────────────────────────────────────────────

/** True while the screen is still bringing the session up. */
export const isHandshakingPhase = (p: SessionPhase): boolean =>
  p === 'handshake' || p === 'engine';

/** True when the robot is awake (engine settled, motors online). */
export const isPostHandshakePhase = (p: SessionPhase): boolean =>
  p === 'ready' || p === 'live';

/** Gate for the "Start conversation" CTA. */
export const canStartConversation = (s: SessionFsmState): boolean =>
  s.phase === 'ready' && s.error === null;

/** Gate for the Back button. Disabled only during teardown. */
export const canLeave = (s: SessionFsmState): boolean => s.phase !== 'leaving';

/** Gate for the conversation pipeline (antennas / OpenAI / wobbler). */
export const isConversationActive = (s: SessionFsmState): boolean =>
  s.phase === 'live';

/**
 * The ConversePanel must be mounted as soon as we leave 'handshake':
 * its DataChannel IS the daemon proxy transport, so wake-up,
 * setMotorMode, and the daemon-status pill all need it. The panel's
 * `convoActive` prop separately gates the conversation pipeline.
 */
export const shouldMountConversePanel = (s: SessionFsmState): boolean =>
  s.phase !== 'handshake';

// ─── Debug helper ────────────────────────────────────────────────────

/**
 * Returns a short human-readable description of an illegal transition,
 * for structured logging. Returns null when the transition was actually
 * legal (state changed). Pair with `createLogger('session.fsm')` to get
 * one warn line per dropped event during dev.
 */
export function describeIllegalTransition(
  prev: SessionFsmState,
  next: SessionFsmState,
  event: SessionEvent,
): string | null {
  if (prev !== next) return null;
  return `event=${event.kind} ignored in phase=${prev.phase} step=${prev.activeStep} hasError=${prev.error !== null}`;
}
