/**
 * Unified presence model for the discovery layer.
 *
 * Why this exists
 * ───────────────
 * Before PR-C the app maintained two parallel lists (BLE devices and
 * central-registered robots) keyed by independent ids, with no notion
 * of "this BLE device and that central entry are the same robot".
 * The data model below is the basis for fusing those two views into a
 * single `RobotPresence` entry per physical robot, keyed by serial.
 *
 * Scope of PR-C
 * ─────────────
 * This file declares the types. The `CentralSource` hook below uses
 * the diagnostic types directly, and `ScanScreen` uses them for the
 * empty-state UI. The full Zustand `PresenceStore` that fuses
 * BLE+central+LAN-HTTP into a single `RobotPresence[]` is staged for
 * a follow-up; we deliberately keep PR-C small so the merge story
 * stays clean. The shape declared here is the contract the future
 * store will populate.
 */

export type Transport = 'ble' | 'lan-http' | 'central-webrtc';

/** Stable identity of a physical robot, independent of how we reached it. */
export interface RobotIdentity {
  /**
   * Hardware serial. The canonical key the BLE adapter advertises and
   * central propagates as `meta.serial` on its `/api/robot-status`
   * payload. When a robot is reachable on multiple transports its
   * presence entries fuse on this value.
   */
  serial: string;
  /** UI label, falls back to serial if neither BLE nor central name it. */
  displayName: string;
  /** Owner's HF handle, populated from central when available. */
  ownerHfHandle?: string;
}

/**
 * Health/status of one transport for one robot. We keep the four-way
 * status enum rather than a bool so the UI can distinguish "we
 * haven't probed yet" from "we probed and the path is dead".
 */
export interface TransportProbe {
  transport: Transport;
  status: 'unknown' | 'reachable' | 'degraded' | 'unreachable';
  /** Epoch ms of the last successful probe. Stale-but-known is useful. */
  lastSeenAt?: number;
  latencyMs?: number;
  lastError?: ConnectionDiagnostic;
}

export interface RobotPresence {
  identity: RobotIdentity;
  /** Sparse: a transport with no probe is implicitly `unknown`. */
  transports: Partial<Record<Transport, TransportProbe>>;
  /**
   * Computed by the store: the transport with the lowest healthy
   * latency, or `null` if no transport is reachable.
   */
  preferredTransport: Transport | null;
  /** Robot is busy serving another consumer (set by central status). */
  busy: { holder: 'self' | 'other' | 'unknown'; since: number } | null;
}

/* --- Typed connection diagnostics --------------------------------------- */

/**
 * Why a typed enum instead of a free-form string: the UI wants to
 * branch ("show retry vs. show sign-in vs. show wifi setup") on each
 * cause, and free-form strings turn into "if (msg.includes('token'))"
 * rabbit holes. Sticking to a discriminated union keeps every empty
 * state actionable.
 */
export type ConnectionDiagnostic =
  | { kind: 'network_error'; message: string }
  | { kind: 'timeout'; message: string }
  | { kind: 'token_rejected'; message: string }
  | { kind: 'http_5xx'; status: number; message: string }
  | { kind: 'http_4xx'; status: number; message: string }
  | { kind: 'empty_list'; message: string }
  | { kind: 'permission_denied'; message: string }
  | { kind: 'unknown'; message: string };

/**
 * Friendly default messages so callers don't all duplicate them.
 * Override with `{ ...defaultDiagnosticMessage(kind), message: ... }`
 * when you have something more specific than the generic one.
 */
export function defaultDiagnosticMessage(
  kind: ConnectionDiagnostic['kind'],
): string {
  switch (kind) {
    case 'network_error':
      return 'Network unreachable. Check your connection.';
    case 'timeout':
      return 'Hugging Face took too long to respond.';
    case 'token_rejected':
      return 'Hugging Face rejected your token. Sign in again.';
    case 'http_5xx':
      return 'Hugging Face is having trouble. Try again in a moment.';
    case 'http_4xx':
      return "Hugging Face refused the request.";
    case 'empty_list':
      return 'No robots registered yet.';
    case 'permission_denied':
      return 'Permission required. Grant access in your device settings.';
    case 'unknown':
      return 'Something unexpected happened. Try again.';
  }
}
