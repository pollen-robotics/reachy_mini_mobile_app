/**
 * Long-lived SSE listener channel to Hugging Face central.
 *
 * Why this exists alongside `fetchRobotsFromCentral`
 * ──────────────────────────────────────────────────
 * `fetchRobotsFromCentral` pulls the current robot list via REST -
 * good enough for a 30 s poll, but never fresh by more than the
 * poll cadence. This module opens the same SSE channel the
 * `ReachyMini` SDK uses for signaling, registers as a `listener`,
 * and surfaces the realtime events central pushes for the user's
 * fleet:
 *
 *   - `list`              initial snapshot at connect time
 *   - `peerStatusChanged` a robot came online / went offline
 *   - `sessionStateChanged` busy / free transition (Palier 2 of
 *                          central-relay-architecture-roadmap.md)
 *
 * Consumers can use it to keep a UI in sync without the round-trip
 * of a poll. The `useRemoteRobots` hook does exactly that: it
 * keeps the REST poll as a safety net (recover if the SSE drops
 * or central restarts) and patches its TanStack Query cache from
 * push events for sub-second updates.
 *
 * Constraints we deliberately respect
 * ───────────────────────────────────
 * - The SDK uses `fetch` + manual stream reader rather than the
 *   native `EventSource` so it can pass the HF token via the
 *   `Authorization` header instead of the URL (no secret in
 *   DevTools / proxy logs / browser history). We do the same.
 * - Central enforces a 1:1 mapping of `token → peer_id`. Opening
 *   a listener stream and then opening the SDK's signaling stream
 *   on the same token will tear the listener down server-side,
 *   which is fine: by the time the SDK opens its stream the
 *   `ScanScreen` has already unmounted and our `close()` has
 *   fired.
 * - The stream is read-only from the user's perspective. We only
 *   ever send a single `setPeerStatus(roles=["listener"])` POST
 *   right after `welcome` so central knows we exist as a target
 *   for `broadcast_to_listeners`.
 *
 * Reconnect policy
 * ────────────────
 * Network blips, HF Space cold-restarts, and proxy idle culls all
 * surface as a stream EOF or fetch error. We retry with exponential
 * backoff capped at `MAX_BACKOFF_MS`, jittered to avoid thundering
 * herds on a central restart. Caller is notified of every state
 * transition through `onConnect` / `onDisconnect` so it can
 * decorate the UI (or trigger a REST refresh on reconnect).
 */
import { CENTRAL_SIGNALING_URL } from '@/shared/env';

/**
 * Initial backoff delay (1 s). Doubles on every consecutive
 * failure up to `MAX_BACKOFF_MS`, then plateaus.
 */
const INITIAL_BACKOFF_MS = 1_000;

/**
 * Cap on the backoff delay. 30 s mirrors the public REST poll
 * cadence so the worst-case staleness on a hung-restart central
 * matches the no-listener fallback. Higher values would make the
 * UI silent for too long after a transient outage.
 */
const MAX_BACKOFF_MS = 30_000;

/**
 * `setPeerStatus(listener)` payload's `meta.name`. Surfaces in
 * central logs as the listener identity, which is useful when
 * grepping for "who's keeping a stream open from a phone in
 * background mode" without DPI traffic. Kept short and human.
 */
const LISTENER_APP_NAME = 'Reachy Mini Mobile (scan)';

/**
 * Shape of a producer entry in the SSE `list` frame and in
 * `/api/robot-status`. Mirrors `get_producers_list` server-side.
 * Kept loose so future fields appear without a wire bump.
 */
export interface CentralStreamProducer {
  id: string;
  meta?: Record<string, unknown>;
  busy?: boolean;
  activeApp?: string | null;
}

export interface CentralListEvent {
  producers: CentralStreamProducer[];
}

export interface CentralPeerStatusChangedEvent {
  peerId: string;
  roles: string[];
  meta?: Record<string, unknown>;
}

export interface CentralSessionStateChangedEvent {
  peerId: string;
  busy: boolean;
  activeApp: string | null;
  meta?: Record<string, unknown>;
}

export interface OpenCentralListenerOpts {
  token: string;
  /**
   * Override the central URL (defaults to `CENTRAL_SIGNALING_URL`).
   * Wired so unit tests can point at a local mock server without
   * patching `import.meta.env`.
   */
  signalingUrl?: string;
  /** First batch of producers received with `welcome`. */
  onList?: (event: CentralListEvent) => void;
  /** A robot came online / went offline (same-owner). */
  onPeerStatusChanged?: (event: CentralPeerStatusChangedEvent) => void;
  /** A robot transitioned busy ↔ free (same-owner, Palier 2). */
  onSessionStateChanged?: (event: CentralSessionStateChangedEvent) => void;
  /**
   * Stream is open and we've sent our `setPeerStatus(listener)`.
   * Caller can hide a "reconnecting" indicator here.
   */
  onConnect?: () => void;
  /**
   * Stream lost (network drop, central restart, scheduled
   * reconnect). Caller can show a faded UI / trigger a REST
   * refetch when the next `onConnect` fires.
   */
  onDisconnect?: (reason: string) => void;
  /**
   * Surface non-fatal errors (parse failure, transient HTTP
   * non-200). Fatal auth errors (401/403) end the stream and
   * call `onDisconnect` with a meaningful reason instead.
   */
  onError?: (err: Error) => void;
}

export interface CentralListenerHandle {
  /**
   * Tear the stream down. Idempotent. Pending fetches are
   * aborted; no further callbacks fire after this returns.
   */
  close(): void;
}

export function openCentralListener(
  opts: OpenCentralListenerOpts,
): CentralListenerHandle {
  const signalingUrl = opts.signalingUrl ?? CENTRAL_SIGNALING_URL;
  let closed = false;
  let abortController: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = INITIAL_BACKOFF_MS;

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (abortController !== null) {
      abortController.abort();
      abortController = null;
    }
  };

  const scheduleReconnect = (reason: string): void => {
    if (closed) return;
    opts.onDisconnect?.(reason);
    // Jitter: ±25% of the current backoff so two clients that
    // dropped on the same central restart don't reconnect in
    // lockstep. Standard exponential-backoff hygiene.
    const jitter = backoff * (Math.random() - 0.5) * 0.5;
    const delay = Math.min(MAX_BACKOFF_MS, Math.round(backoff + jitter));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
      void runStream();
    }, delay);
  };

  const sendListenerRegistration = async (): Promise<void> => {
    // Best-effort: if this POST fails we still keep the stream
    // open. Central will fall back to TTL-evicting us as a peer
    // without a role, but our SSE channel keeps receiving events.
    // We do log it though - it's the canary signal for a 4xx
    // schema mismatch between this client and a future central.
    try {
      const resp = await fetch(`${signalingUrl}/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.token}`,
        },
        body: JSON.stringify({
          type: 'setPeerStatus',
          roles: ['listener'],
          meta: { name: LISTENER_APP_NAME },
        }),
        signal: abortController?.signal,
      });
      if (!resp.ok) {
        opts.onError?.(
          new Error(`setPeerStatus(listener) returned HTTP ${resp.status}`),
        );
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      opts.onError?.(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  };

  const handleMessage = (msg: { type?: string } & Record<string, unknown>): void => {
    switch (msg.type) {
      case 'welcome':
        // Reset backoff on a successful welcome - any subsequent
        // drop starts retrying from 1 s, not from the previous
        // capped delay.
        backoff = INITIAL_BACKOFF_MS;
        // Fire the listener registration AFTER welcome (central
        // requires the SSE channel be established before it
        // accepts a /send for this peer).
        void sendListenerRegistration();
        opts.onConnect?.();
        return;
      case 'list':
        opts.onList?.({
          producers: Array.isArray(msg.producers)
            ? (msg.producers as CentralStreamProducer[])
            : [],
        });
        return;
      case 'peerStatusChanged':
        opts.onPeerStatusChanged?.({
          peerId: typeof msg.peerId === 'string' ? msg.peerId : '',
          roles: Array.isArray(msg.roles) ? (msg.roles as string[]) : [],
          meta:
            msg.meta && typeof msg.meta === 'object'
              ? (msg.meta as Record<string, unknown>)
              : undefined,
        });
        return;
      case 'sessionStateChanged':
        opts.onSessionStateChanged?.({
          peerId: typeof msg.peerId === 'string' ? msg.peerId : '',
          busy: msg.busy === true,
          activeApp: typeof msg.activeApp === 'string' ? msg.activeApp : null,
          meta:
            msg.meta && typeof msg.meta === 'object'
              ? (msg.meta as Record<string, unknown>)
              : undefined,
        });
        return;
      // Other types (`peer`, `startSession`, `endSession`, `ping`)
      // are session-scoped and only fire when this peer becomes a
      // consumer or producer. As a pure listener we ignore them.
      default:
        return;
    }
  };

  const runStream = async (): Promise<void> => {
    if (closed) return;
    abortController = new AbortController();
    const signal = abortController.signal;

    let resp: Response;
    try {
      resp = await fetch(`${signalingUrl}/events`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${opts.token}` },
        signal,
      });
    } catch (err) {
      if (closed) return;
      const reason = err instanceof Error ? err.message : String(err);
      scheduleReconnect(`fetch failed: ${reason}`);
      return;
    }

    if (resp.status === 401 || resp.status === 403) {
      // Auth failures are fatal - retrying with the same bad
      // token would just rate-limit us. Surface as an error and
      // stop. The caller's onError handler is expected to
      // propagate to the auth flow (e.g. drop the token).
      opts.onError?.(
        new Error(`Hugging Face central rejected the token (HTTP ${resp.status})`),
      );
      close();
      opts.onDisconnect?.('auth_rejected');
      return;
    }
    if (!resp.ok || resp.body === null) {
      scheduleReconnect(`HTTP ${resp.status}`);
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are line-delimited; the canonical separator
        // is `\n\n` between events but the reachy_mini_central
        // implementation pushes one `data: ...\n` per event,
        // matching the SDK's parser. We split on `\n` and only
        // act on the `data:` lines, mirroring the SDK.
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload.length === 0) continue;
          try {
            handleMessage(JSON.parse(payload) as Record<string, unknown>);
          } catch (err) {
            opts.onError?.(
              err instanceof Error ? err : new Error(String(err)),
            );
          }
        }
      }
      if (closed) return;
      scheduleReconnect('stream ended');
    } catch (err) {
      if (signal.aborted || closed) return;
      const reason = err instanceof Error ? err.message : String(err);
      scheduleReconnect(`read failed: ${reason}`);
    }
  };

  void runStream();

  return { close };
}
