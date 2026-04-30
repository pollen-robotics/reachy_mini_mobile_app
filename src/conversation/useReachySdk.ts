/**
 * Loader for the ReachyMini JS SDK.
 *
 * The SDK lives at `pollen-robotics/reachy-mini@feat/ehance-js-lib`
 * and ships as an ES module. We previously injected a
 * `<script type="module">` tag pointing at jsdelivr's CDN copy; that
 * worked fine in desktop browsers but on iOS WKWebView under
 * `tauri://localhost` the module fetch was silently dropped under
 * some CSP/network conditions (no `error` event, no `load` event,
 * SDK stuck in `loading` forever, DataChannel never created — see
 * `[uxxxx] webrtc.proxy fetch.no_dc` in the device logs).
 *
 * Now we ship the SDK source in `src/vendor/reachy-mini.js` and let
 * Vite bundle it (and its `@huggingface/hub` dep) into the app. The
 * loader keeps the same async/imperative shape so the rest of the
 * codebase (engine, ConversePanel, patch hook) doesn't have to know
 * the bytes are coming from the bundle rather than the network.
 *
 * Token bridge: before the SDK calls `authenticate()`, it looks for
 * an existing HF access token in `sessionStorage.hf_token`. The
 * mobile app already obtained one via the daemon's OAuth flow
 * (`useHfAuth`); we push it into sessionStorage so the SDK picks it
 * up without having to redirect the webview to
 * `huggingface.co/login`.
 */
import { useEffect, useState } from 'react';

import { getDataChannelId, setActiveDataChannel } from '../robot-client';

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

let globalLoadState: LoadState = 'idle';
let globalError: Error | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/**
 * Dump a focused subset of `pc.getStats()` to the console: selected
 * candidate pair (local + remote IP/port), DTLS transport state, and
 * any data-channel reports. Called the moment ICE reaches `connected`
 * so we can tell at a glance whether the path is actually viable for
 * DTLS or whether the negotiated pair can't carry encrypted bytes.
 *
 * Re-runs every second for up to 8s while connection state is still
 * `connecting`, so we capture the exact moment DTLS gives up (or
 * succeeds, in which case we stop).
 */
async function dumpPcStats(pc: RTCPeerConnection): Promise<void> {
  const start = Date.now();
  const interval = setInterval(async () => {
    if (Date.now() - start > 8000) {
      clearInterval(interval);
      return;
    }
    if (
      pc.connectionState === 'connected' ||
      pc.connectionState === 'failed' ||
      pc.connectionState === 'closed'
    ) {
      clearInterval(interval);
    }
    try {
      const stats = await pc.getStats();
      const reports: Record<string, unknown>[] = [];
      const byId = new Map<string, Record<string, unknown>>();
      stats.forEach((report) => {
        byId.set(report.id, report as unknown as Record<string, unknown>);
      });
      stats.forEach((report) => {
        const r = report as unknown as Record<string, unknown>;
        if (
          r.type === 'candidate-pair' &&
          (r.nominated === true || r.selected === true || r.state === 'succeeded')
        ) {
          const local = byId.get(r.localCandidateId as string);
          const remote = byId.get(r.remoteCandidateId as string);
          reports.push({
            kind: 'candidate-pair',
            state: r.state,
            nominated: r.nominated,
            bytesSent: r.bytesSent,
            bytesReceived: r.bytesReceived,
            currentRoundTripTime: r.currentRoundTripTime,
            local: local
              ? {
                  type: local.candidateType,
                  protocol: local.protocol,
                  address: local.address ?? local.ip,
                  port: local.port,
                }
              : null,
            remote: remote
              ? {
                  type: remote.candidateType,
                  protocol: remote.protocol,
                  address: remote.address ?? remote.ip,
                  port: remote.port,
                }
              : null,
          });
        }
        if (r.type === 'transport') {
          reports.push({
            kind: 'transport',
            dtlsState: r.dtlsState,
            iceState: r.iceState,
            selectedCandidatePairId: r.selectedCandidatePairId,
            bytesSent: r.bytesSent,
            bytesReceived: r.bytesReceived,
          });
        }
        if (r.type === 'data-channel') {
          reports.push({
            kind: 'data-channel',
            label: r.label,
            state: r.state,
            messagesSent: r.messagesSent,
            messagesReceived: r.messagesReceived,
          });
        }
      });
      // Stringify the reports inline so the console flattens them into
      // text instead of `Array(2)Object Prototype` placeholders -
      // copy/paste from the Web Inspector should give us every field
      // we care about (dtlsState, candidate pair IPs, …) on one line.
      console.info(
        '[ReachyMini stats] elapsedMs=' +
          (Date.now() - start) +
          ' connectionState=' +
          pc.connectionState +
          ' reports=' +
          JSON.stringify(reports),
      );
    } catch (err) {
      console.warn('[ReachyMini stats] getStats failed', err);
    }
  }, 1000);
}

/**
 * Monkey-patch `ReachyMini.prototype._handlePeerMessage` to work around
 * two known issues with the central-HF signaling relay that break
 * first-session establishment on mobile:
 *
 * 1. **Stale-session leakage** — when a client kills its tab without a
 *    clean `disconnect()`, central HF keeps the old session in memory
 *    for a while and relays its tail of ICE candidates to the next
 *    client that connects with the same HF peerId. The unpatched SDK
 *    applies every `peer` message to the current `_pc`, regardless of
 *    which session it originally targeted.
 *
 * 2. **ICE-before-offer race** — because `_handlePeerMessage` calls
 *    `addIceCandidate()` directly, any ICE candidate that arrives
 *    before `setRemoteDescription(offer)` throws
 *    "InvalidStateError: The remote description was null". Chrome
 *    buffers these internally; the iOS/macOS WebView used by Tauri
 *    does not.
 *
 * The patch does two things:
 *   - **sessionId filter**: drop peer messages tagged with a
 *     `sessionId` that doesn't match `this._sessionId` (when both are
 *     known). While `this._sessionId` is still null during the initial
 *     startSession handshake, we let the message through so the
 *     legitimate first offer is never dropped.
 *   - **ICE buffering**: if an ICE candidate arrives while
 *     `_pc.remoteDescription` is null, queue it and flush the queue
 *     after the offer sets the remote description.
 *
 * Idempotent: patches only the first time, no-ops on re-entry.
 */
function patchReachyMiniStaleSession(): void {
  const ReachyMini = (window as unknown as { ReachyMini?: { prototype: Record<string, unknown> } })
    .ReachyMini;
  if (!ReachyMini) return;
  interface PeerMessage {
    sessionId?: string;
    ice?: RTCIceCandidateInit;
    sdp?: { type: string; sdp: string };
  }
  interface ReachyMiniInstance {
    _pc: RTCPeerConnection | null;
    _sessionId: string | null;
    _pendingIce?: RTCIceCandidateInit[];
  }
  type HandlePeerMessage = (this: ReachyMiniInstance, msg: PeerMessage) => Promise<void>;

  const proto = ReachyMini.prototype as Record<string, unknown> & {
    __reachyMiniPatched?: boolean;
    _handlePeerMessage?: HandlePeerMessage;
    _handleSignalingMessage?: (
      this: ReachyMiniInstance,
      msg: { type: string } & PeerMessage & { reason?: string; robots?: unknown },
    ) => Promise<void> | void;
  };
  if (proto.__reachyMiniPatched) return;
  const original = proto._handlePeerMessage;
  if (typeof original !== 'function') return;

  const patched: HandlePeerMessage = async function patched(
    this: ReachyMiniInstance,
    msg: PeerMessage,
  ): Promise<void> {
    const kind = msg.sdp
      ? `sdp:${msg.sdp.type}`
      : msg.ice
        ? 'ice'
        : 'other';
    console.info('[ReachyMini patch] peer msg', {
      kind,
      incomingSid: msg.sessionId ?? null,
      ourSid: this._sessionId ?? null,
      hasPc: Boolean(this._pc),
      hasRemoteDesc: Boolean(this._pc?.remoteDescription),
    });

    // Dump the actual SDP body so we can verify the negotiation
    // includes a `m=application` data channel section. If the robot's
    // gstreamer producer is mis-configured and never advertises one,
    // `pc.ondatachannel` will never fire and `startSession()` will
    // time out forever - this log is the single fastest way to spot
    // the issue.
    if (msg.sdp) {
      const sdpBody = msg.sdp.sdp ?? '';
      const mLines = sdpBody
        .split('\n')
        .filter((line: string) => line.startsWith('m='))
        .map((line: string) => line.trim());
      console.info('[ReachyMini patch] SDP body', {
        type: msg.sdp.type,
        mLines,
        hasDataChannel: mLines.some((l: string) => l.startsWith('m=application')),
        bytes: sdpBody.length,
      });
    }
    if (msg.ice && msg.ice.candidate) {
      console.info('[ReachyMini patch] remote ICE', {
        candidate: msg.ice.candidate,
      });
    }

    if (!this._pc) return;
    const pc = this._pc;

    // (1) Stale session guard. We have both a known local sessionId
    // and a tagged incoming sessionId, and they differ → ignore. This
    // is the case when central replays a previous session's tail.
    if (this._sessionId && msg.sessionId && msg.sessionId !== this._sessionId) {
      console.warn('[ReachyMini patch] DROPPING stale-session peer msg', {
        kind,
        ours: this._sessionId,
        theirs: msg.sessionId,
      });
      return;
    }

    // (2) SDP-state guard. The reachy-mini SDK blindly forwards every
    // `sdp:*` message to `setRemoteDescription`. When the same session
    // yields two messages we don't expect (e.g. a duplicated answer
    // replayed by the central relay after reconnect, or the producer
    // re-sending an offer after we've already stabilised), Safari /
    // WKWebView throws InvalidStateError and the engine fatal-errors
    // out. We gate on `signalingState`:
    //
    //   - `sdp:offer` is only welcome in `stable` or `have-remote-offer`
    //     (the latter for a re-send of the same offer; idempotent).
    //   - `sdp:answer` is only welcome in `have-local-offer`. Anywhere
    //     else means we've either already applied an answer or we're
    //     not the offerer this round.
    if (msg.sdp) {
      const state = pc.signalingState;
      const sdpType = msg.sdp.type;
      if (sdpType === 'answer' && state !== 'have-local-offer') {
        console.warn('[ReachyMini patch] DROPPING sdp:answer in unexpected state', {
          state,
          sid: this._sessionId,
        });
        return;
      }
      if (
        sdpType === 'offer' &&
        state !== 'stable' &&
        state !== 'have-remote-offer'
      ) {
        console.warn('[ReachyMini patch] DROPPING sdp:offer in unexpected state', {
          state,
          sid: this._sessionId,
        });
        return;
      }
    }

    // (3) ICE sanity. Three quirks to absorb:
    //   - End-of-candidates is sometimes signalled by an object with
    //     an empty `candidate` string. WKWebView's RTCIceCandidate
    //     constructor rejects those with "Expect line: candidate:…".
    //     We just skip: addIceCandidate(null) is the canonical EOC
    //     signal anyway, and the peer connection recovers without it.
    //   - ICE arriving before the remote description is set throws on
    //     Safari/iOS. We buffer and flush post-offer.
    //   - ICE-TCP candidates from gstreamer's webrtcsink complete the
    //     STUN binding handshake (so `iceConnectionState` reaches
    //     `connected`) but never carry DTLS bytes back to us, leaving
    //     the connection wedged at `dtlsState: connecting` until
    //     `startSession()` times out. Confirmed via getStats() on
    //     macOS Tauri WKWebView: selected pair was `prflx/tcp ↔
    //     host/tcp`, `bytesSent: 1224`, `bytesReceived: 0`. We drop
    //     every `tcptype` candidate so ICE falls back to UDP/IPv4
    //     host pairs (192.168.x ↔ 192.168.x), which DO carry DTLS
    //     end-to-end on the same LAN.
    if (msg.ice && !msg.sdp) {
      const candidateStr = (msg.ice as { candidate?: string }).candidate;
      if (candidateStr === '' || candidateStr == null) {
        console.info('[ReachyMini patch] skipping end-of-candidates ICE', {
          sid: this._sessionId,
        });
        return;
      }
      // RFC 5245 / 8839: every ICE-TCP candidate carries a `tcptype`
      // attribute (`active`, `passive` or `so`). UDP candidates never
      // do.
      //
      // We only drop the *host-TCP* family. Those are gstreamer
      // webrtcsink's local LAN TCP listeners, and we've confirmed
      // (getStats: bytesSent>0 / bytesReceived=0, dtlsState stuck on
      // "connecting") that ICE happily nominates them but DTLS never
      // makes it across, wedging the session at "starting…" until
      // the engine's 15 s timeout. Forcing those off lets ICE fall
      // back to UDP host / srflx pairs that *do* carry DTLS.
      //
      // CRUCIALLY we keep `typ srflx` and `typ relay` TCP candidates
      // around. Those are the only viable path when the phone is
      // behind a symmetric NAT (cellular, captive Wi-Fi, …) and the
      // remote operator we just added (`openrelay.metered.ca:443?
      // transport=tcp`) needs them on both sides to actually relay
      // bytes through the TURN server.
      const tcpHostMatch = /\btyp\s+host\b[^]*\btcptype\s+\w+\b/i.test(candidateStr);
      if (tcpHostMatch) {
        console.info('[ReachyMini patch] dropping host-TCP remote ICE', {
          sid: this._sessionId,
          candidate: candidateStr,
        });
        return;
      }
      if (pc.remoteDescription === null) {
        this._pendingIce = this._pendingIce || [];
        this._pendingIce.push(msg.ice);
        console.info('[ReachyMini patch] buffered ICE (offer not yet applied)', {
          pending: this._pendingIce.length,
        });
        return;
      }
    }

    await original.call(this, msg);

    if (
      msg.sdp &&
      msg.sdp.type === 'offer' &&
      this._pc &&
      this._pendingIce &&
      this._pendingIce.length > 0
    ) {
      const queued = this._pendingIce;
      this._pendingIce = [];
      for (const ice of queued) {
        try {
          await this._pc.addIceCandidate(new RTCIceCandidate(ice));
        } catch (err) {
          console.debug('[ReachyMini patch] late ICE failed to apply', err);
        }
      }
    }
  };

  proto._handlePeerMessage = patched;

  // Also trace every signaling message so we can see what central
  // actually pushes on the SSE (welcome, list, sessionStarted,
  // sessionRejected, endSession, peer, …). Useful when the UI is
  // stuck and we need to know if the offer ever arrived at all.
  const originalSignal = proto._handleSignalingMessage as
    | ((this: ReachyMiniInstance, msg: { type: string }) => Promise<void> | void)
    | undefined;
  if (typeof originalSignal === 'function') {
    proto._handleSignalingMessage = async function tracedSignaling(
      this: ReachyMiniInstance,
      msg: { type: string } & PeerMessage & { reason?: string; robots?: unknown },
    ): Promise<void> {
      console.info('[ReachyMini trace] signaling', {
        type: msg.type,
        sessionId: msg.sessionId ?? null,
        reason: msg.reason ?? null,
        ourSid: this._sessionId ?? null,
      });
      await originalSignal.call(this, msg);
    };
  }

  // Trace every HTTP POST to central. Specifically, we want to know
  // what `startSession` returns: the SDK only extracts `sessionId` but
  // if central ever responded with an inline `sdp` (offer) we'd never
  // see it. This shows us the full response body for every
  // _sendToServer call.
  const protoSend = proto as Record<string, unknown> & {
    _sendToServer?: (
      this: ReachyMiniInstance,
      msg: { type?: string },
    ) => Promise<unknown>;
  };
  const originalSend = protoSend._sendToServer;
  if (typeof originalSend === 'function') {
    protoSend._sendToServer = async function tracedSend(
      this: ReachyMiniInstance,
      msg: { type?: string },
    ): Promise<unknown> {
      const result = await originalSend.call(this, msg);
      if (msg?.type === 'startSession' || msg?.type === 'endSession') {
        console.info('[ReachyMini trace] _sendToServer response', {
          sentType: msg.type,
          response: result,
        });
      }
      return result;
    };
  }

  // Instrument RTCPeerConnection state changes so we can see WHY
  // `startSession()` hangs in the SDK. The SDK only resolves
  // `_sessionResolve` when *both* `iceConnectionState` reaches
  // `connected`/`completed` AND the data channel emits `open`. When
  // `startSession` times out after 15s, the interesting signal is
  // which of the two (or both) never fired. Rather than patching
  // every individual path, we hook the SDK the first time it sets
  // `this._pc` to a new PeerConnection and attach listeners there.
  //
  // We patch the underlying `RTCPeerConnection` constructor once so
  // every instance created inside the SDK starts pre-instrumented.
  // This is safer than trying to intercept `ReachyMini.startSession`
  // directly because the SDK creates the PC inline inside that
  // method and we'd have to race its own handler assignments.
  interface TracedPc extends RTCPeerConnection {
    __reachyTraced?: boolean;
  }
  const OriginalPc = window.RTCPeerConnection;
  if (!(OriginalPc as unknown as { __reachyTraced?: boolean }).__reachyTraced) {
    const PatchedPc = function PatchedRTCPeerConnection(
      ...args: ConstructorParameters<typeof RTCPeerConnection>
    ): RTCPeerConnection {
      // Inject TURN relays into every RTCPeerConnection the SDK creates.
      // The reachy-mini SDK hard-codes a STUN-only config
      // (`stun:stun.l.google.com:19302`), which is fine on a LAN but
      // fails the moment the client and robot sit behind symmetric
      // NATs (any consumer 4G/5G or many corporate networks). We
      // amend the config with public free TURN endpoints so ICE has
      // a relay candidate to fall back on. Local network paths (host
      // ↔ host) and STUN-derived srflx pairs are still tried first
      // and preferred when usable, so this has no impact on LAN
      // performance.
      //
      // openrelay.metered.ca is the de-facto reference for free
      // unauthenticated TURN; we list both UDP and TCP/443 to cover
      // strict outbound firewalls. When we eventually run our own
      // coturn (or HF central exposes managed creds), this default
      // can be replaced by reading the config from the daemon's
      // /api/webrtc/ice-config endpoint instead.
      const TURN_FALLBACK: RTCIceServer[] = [
        { urls: 'stun:stun.l.google.com:19302' },
        {
          urls: [
            'turn:openrelay.metered.ca:80',
            'turn:openrelay.metered.ca:443',
            'turn:openrelay.metered.ca:443?transport=tcp',
          ],
          username: 'openrelayproject',
          credential: 'openrelayproject',
        },
      ];
      const config = (args[0] ?? {}) as RTCConfiguration;
      const existing = Array.isArray(config.iceServers) ? config.iceServers : [];
      const merged: RTCIceServer[] = [...existing];
      for (const entry of TURN_FALLBACK) {
        const urls = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
        const alreadyHas = merged.some((s) => {
          const sUrls = Array.isArray(s.urls) ? s.urls : [s.urls];
          return urls.some((u) => sUrls.includes(u));
        });
        if (!alreadyHas) merged.push(entry);
      }
      const augmented: RTCConfiguration = { ...config, iceServers: merged };
      args[0] = augmented;
      console.info('[ReachyMini patch] RTCPeerConnection config', {
        iceServers: merged.map((s) => s.urls),
      });
      const pc = new OriginalPc(...args) as TracedPc;
      if (pc.__reachyTraced) return pc;
      pc.__reachyTraced = true;
      pc.addEventListener('iceconnectionstatechange', () => {
        console.info('[ReachyMini trace] pc.iceConnectionState', {
          state: pc.iceConnectionState,
        });
        // The moment ICE is up, dump getStats() so we can see what
        // candidate pair was nominated, the DTLS transport state, and
        // the data channel state (if any). This is the diagnostic
        // anchor for the "ICE connected but startSession never
        // resolves" failure mode: if DTLS is stuck, we'll see the
        // selected pair's `dtlsState: connecting` and no
        // `data-channel` report at all.
        if (
          pc.iceConnectionState === 'connected' ||
          pc.iceConnectionState === 'completed'
        ) {
          void dumpPcStats(pc);
        }
      });
      pc.addEventListener('connectionstatechange', () => {
        console.info('[ReachyMini trace] pc.connectionState', {
          state: pc.connectionState,
        });
      });
      pc.addEventListener('icegatheringstatechange', () => {
        console.info('[ReachyMini trace] pc.iceGatheringState', {
          state: pc.iceGatheringState,
        });
      });
      pc.addEventListener('signalingstatechange', () => {
        console.info('[ReachyMini trace] pc.signalingState', {
          state: pc.signalingState,
        });
      });
      pc.addEventListener('datachannel', (ev) => {
        const dc = (ev as RTCDataChannelEvent).channel;
        const dcId = getDataChannelId(dc);
        console.info('[ReachyMini trace] pc.ondatachannel', {
          label: dc.label,
          readyState: dc.readyState,
          dc_id: dcId,
        });
        // Publish the DC into the robot-client registry so the
        // remote-mode HTTP transport (`http_proxy` over DataChannel)
        // can piggyback on the SDK's existing channel. We can't open
        // a parallel one without an SDP renegotiation we don't
        // control, so we share the SDK's. The daemon-side dispatcher
        // pydantic-validates each message and only `http_proxy`
        // payloads hit our new branch, so the SDK's typed traffic
        // is unaffected. See `src/robot-client/webrtcClient.ts`.
        const publish = () => {
          if (dc.readyState === 'open') setActiveDataChannel(dc);
        };
        if (dc.readyState === 'open') {
          setActiveDataChannel(dc);
        }
        dc.addEventListener('open', () => {
          console.info('[ReachyMini trace] dc.open', { label: dc.label, dc_id: dcId });
          publish();
        });
        dc.addEventListener('close', () => {
          console.info('[ReachyMini trace] dc.close', { label: dc.label, dc_id: dcId });
          setActiveDataChannel(null);
        });
        dc.addEventListener('error', (e) => {
          console.warn('[ReachyMini trace] dc.error', { label: dc.label, dc_id: dcId, e });
        });
      });
      pc.addEventListener('track', (ev) => {
        const te = ev as RTCTrackEvent;
        console.info('[ReachyMini trace] pc.ontrack', {
          kind: te.track.kind,
          muted: te.track.muted,
          readyState: te.track.readyState,
        });
      });
      return pc;
    } as unknown as typeof RTCPeerConnection;
    PatchedPc.prototype = OriginalPc.prototype;
    (PatchedPc as unknown as { __reachyTraced?: boolean }).__reachyTraced = true;
    window.RTCPeerConnection = PatchedPc;
  }

  proto.__reachyMiniPatched = true;
  console.info('[ReachyMini patch] session/ICE guards installed');
}

/**
 * Kicks off the SDK load exactly once per page. Safe to call from any
 * number of mounts: later callers piggy-back on the first load.
 *
 * The dynamic `import()` is resolved at build time by Vite — no
 * network round-trip, no CSP surprises. We still expose
 * `window.ReachyMini` for parity with the previous CDN flow and so
 * the patch hook can grab the constructor through its prototype.
 */
function ensureLoaded(): void {
  if (globalLoadState !== 'idle') return;
  if (typeof window === 'undefined') return;

  if (window.ReachyMini) {
    patchReachyMiniStaleSession();
    globalLoadState = 'ready';
    console.info('[ReachyMini sdk] reusing already-loaded constructor');
    notify();
    return;
  }

  globalLoadState = 'loading';
  notify();
  console.info('[ReachyMini sdk] loading vendored bundle');

  void (async () => {
    try {
      // The vendored SDK ships as plain JS with no .d.ts; we don't
      // enable `allowJs` so TS can't resolve the import. The runtime
      // shape is verified below by checking for a callable export.
      // @ts-expect-error - vendored JS bundle (see reachy-mini.d.ts)
      const mod = await import('../vendor/reachy-mini.js');
      const Ctor =
        (mod as { ReachyMini?: unknown; default?: unknown }).ReachyMini ??
        (mod as { default?: unknown }).default;
      if (typeof Ctor !== 'function') {
        throw new Error(
          'reachy-mini bundle did not export a ReachyMini constructor',
        );
      }
      (window as unknown as { ReachyMini: unknown }).ReachyMini = Ctor;
      patchReachyMiniStaleSession();
      globalLoadState = 'ready';
      console.info('[ReachyMini sdk] ready');
      notify();
    } catch (err) {
      globalLoadState = 'error';
      globalError =
        err instanceof Error
          ? err
          : new Error(`Failed to load reachy-mini bundle: ${String(err)}`);
      console.error('[ReachyMini sdk] load.failed', globalError);
      notify();
    }
  })();
}

// ─── HF session seeding ───────────────────────────────────────────────
//
// The SDK reads three keys on `authenticate()`: `hf_token`,
// `hf_username` and `hf_token_expires`. Seeding only the token
// silently makes `authenticate()` return false and the engine stays
// in "signed-out" even with a valid token. The mobile app handles
// the seed in `useRemoteHfToken` (gate-side, sourced from the user's
// own OAuth session); we used to mirror it here too via a
// `seedHfToken` helper, but the parent now owns that flow as the
// single source of truth and the helper had no remaining callers.
// If a future surface needs to seed the SDK from a different path
// (e.g. from the Apps tab when forwarding into a sandboxed iframe),
// re-introduce the helper here rather than duplicating the
// three-key write inline.

export interface UseReachySdkResult {
  isReady: boolean;
  isLoading: boolean;
  error: Error | null;
}

export function useReachySdk(): UseReachySdkResult {
  const [, force] = useState(0);

  useEffect(() => {
    const tick = () => force((n) => n + 1);
    listeners.add(tick);
    ensureLoaded();
    return () => {
      listeners.delete(tick);
    };
  }, []);

  return {
    isReady: globalLoadState === 'ready',
    isLoading: globalLoadState === 'loading' || globalLoadState === 'idle',
    error: globalLoadState === 'error' ? globalError : null,
  };
}
