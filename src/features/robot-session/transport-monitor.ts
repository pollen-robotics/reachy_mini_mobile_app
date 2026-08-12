/**
 * Live classification of the WebRTC peer connection's selected ICE
 * candidate pair.
 *
 * Polls `pc.getStats()` every ~1.5 s and surfaces the kind via an
 * external listener. The mobile app feeds this into structured
 * connection telemetry; the Space app used to render a transport
 * pill in the orb chrome.
 *
 * Self-contained: no closure dependencies. The host wires a
 * `(kind) => void` callback on `start()`; everything else (timer,
 * stats parsing, dedupe) lives inside the class.
 */

export type TransportKind =
  | 'checking' // ICE still gathering / no nominated pair yet
  | 'lan' // host ↔ host (same LAN, RFC1918 IPs)
  | 'direct' // direct UDP, NAT punched through
  | 'relay'; // TURN relayed (corporate proxy / symmetric NAT)

/**
 * Listener payload. `bps` is the instantaneous downstream + upstream
 * bitrate measured on the selected candidate pair (or summed over
 * inbound/outbound RTP when the pair doesn't carry byte counters yet,
 * which happens on Safari). `null` while we don't have two samples to
 * diff yet (typically the first ~1.5 s after connection).
 *
 * `remoteIp` is the address of the selected remote ICE candidate (the
 * robot's address as seen from this peer). It can be:
 *   - a literal IPv4 / IPv6 string (most LAN setups, including the
 *     `192.168.x.y` we want to display for SSH debug);
 *   - a `*.local` mDNS hostname when host-candidate privacy strips
 *     the IP (Chrome / Firefox default outside of secure contexts);
 *   - `null` when the field is missing entirely (Safari) or before
 *     ICE has nominated a pair.
 *
 * Surfaced primarily so the session topbar can display the robot's
 * reachable address for ad-hoc debug (SSH, `curl`, …). Consumers
 * should treat it as informational, not addressable, because of the
 * mDNS / null cases above.
 */
export interface TransportInfo {
  kind: TransportKind;
  bps: number | null;
  remoteIp: string | null;
  /**
   * Rolling-min round-trip time on the selected candidate pair, in
   * milliseconds, or `null` when the platform doesn't expose it (iOS
   * WKWebView). This - NOT `bps` - is the meaningful link-QUALITY
   * signal: latency drives perceived voice quality, whereas `bps` is
   * capped at 32 kbps and tracks speech activity. The UI maps it to
   * signal bars via {@link linkQualityLevel}; `kind` becomes a
   * separate "topology" tag rather than the bars' driver.
   */
  rttMs: number | null;
}

/**
 * Coarse link-quality level used by the topbar's signal bars.
 * `0` = unknown / still measuring (rendered as muted/empty bars).
 */
export type LinkQuality = 0 | 1 | 2 | 3;

/** RTT (ms) cut-offs for the 3 → 2 and 2 → 1 bar transitions. */
const RTT_GOOD_MS = 40; // < 40 ms  : excellent, imperceptible → 3 bars
const RTT_OK_MS = 150; // < 150 ms : usable                  → 2 bars
//                        ≥ 150 ms : laggy                    → 1 bar

/**
 * Map the live transport to a 0-3 quality level for the signal bars.
 *
 * Prefers RTT (the real quality axis); falls back to the topology
 * `kind` only when RTT is unavailable (iOS WKWebView doesn't expose
 * `currentRoundTripTime`), so the bars still say something sensible
 * there. A fast `direct` link therefore shows 3 full bars on
 * RTT-capable platforms instead of being capped at 2 by topology -
 * which was the whole point of moving off a kind-driven mapping.
 *
 * Shared by the monitor (to dedupe emissions on level changes) and by
 * the `<LinkQualityBars>` renderer, so thresholds live in exactly one
 * place.
 */
export function linkQualityLevel(rttMs: number | null, kind: TransportKind): LinkQuality {
  if (rttMs !== null) {
    if (rttMs < RTT_GOOD_MS) return 3;
    if (rttMs < RTT_OK_MS) return 2;
    return 1;
  }
  switch (kind) {
    case 'lan':
      return 3;
    case 'direct':
      return 2;
    case 'relay':
      return 1;
    default:
      return 0; // checking
  }
}

interface RTCIceCandidateStat {
  id: string;
  candidateType?: 'host' | 'srflx' | 'prflx' | 'relay';
  /**
   * Candidate address as it appears in the SDP. Either a literal
   * IPv4/IPv6 address or a `*.local` mDNS hostname when the browser
   * applies host-candidate privacy (Chrome / Firefox by default).
   *
   * Standard name is `address`, but older Chromium and Safari still
   * expose it as `ip` - we read both so we don't lose the signal on
   * those engines.
   */
  address?: string;
  /** Legacy field name, kept for older Chromium / Safari builds. */
  ip?: string;
}

interface RTCStatsWithCandidates {
  type: string;
  nominated?: boolean;
  state?: string;
  localCandidateId?: string;
  remoteCandidateId?: string;
}

/**
 * RTT floor (ms) below which a host↔host pair is treated as physically
 * local even when addressing is ambiguous. A genuine LAN pair floors
 * sub-few-ms; an internet hop never dips below ~5 ms, so the value is
 * a conservative "same L2" cut-off. Only ever UPGRADES to `lan` - it's
 * one of three OR-ed signals, never the sole authority.
 */
const LAN_RTT_MAX_MS = 5;
/**
 * Number of RTT samples kept for the rolling-min. ~6 ticks ≈ 9 s of
 * history: long enough that a single Wi-Fi jitter spike can't bounce
 * us out of `lan` (we classify off the min, i.e. the path floor).
 */
const RTT_WINDOW_SIZE = 6;

export class TransportMonitor {
  private pc: RTCPeerConnection | null = null;
  private timer: number | null = null;
  private lastKind: TransportKind | null = null;
  private lastBps: number | null = null;
  private lastRemoteIp: string | null = null;
  private lastLevel: LinkQuality | null = null;
  // Rolling window of recent RTT samples (ms) on the selected pair.
  // Classification reads the MIN over the window so transient jitter
  // can't drop us out of `lan`; the floor reflects the physical path.
  private rttWindowMs: number[] = [];
  // External listener wired via `start(pc, listener)`. Captured per
  // session and cleared on `stop()` so it can't leak to the next
  // engine mount when the singleton is reused.
  private listener: ((info: TransportInfo) => void) | null = null;
  // Last snapshot of cumulative byte counters so we can diff against the
  // next tick and compute a bitrate. -1 means "no prior sample yet".
  private prevBytesSent = -1;
  private prevBytesRecv = -1;
  private prevSampleTs = 0;

  start(
    pc: RTCPeerConnection,
    listener: ((info: TransportInfo) => void) | null = null,
  ): void {
    this.stop();
    this.pc = pc;
    this.listener = listener;
    this.show('checking', null, null, null);
    // 1.5 s strikes a decent balance: responsive enough that the bitrate
    // feels live, but infrequent enough that `getStats()` doesn't show up
    // on the main-thread profile.
    this.timer = window.setInterval(() => this.tick(), 1_500);
    window.setTimeout(() => this.tick(), 600);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.pc = null;
    this.listener = null;
    this.lastKind = null;
    this.lastBps = null;
    this.lastRemoteIp = null;
    this.lastLevel = null;
    this.rttWindowMs = [];
    this.prevBytesSent = -1;
    this.prevBytesRecv = -1;
    this.prevSampleTs = 0;
  }

  /**
   * Force the published transport kind back to `'checking'` without
   * waiting for the next `getStats()` tick to confirm it. Intended
   * for the engine to call when it observes an external degradation
   * signal (`iceStateChange === 'disconnected' | 'failed'`,
   * `networkOffline`) - those signals are deterministic, whereas
   * `getStats()` behaviour during a degrading link is browser-
   * specific (some keep the candidate-pair as `succeeded` for a
   * while, some drop it immediately, Safari sometimes returns
   * empty stats). Forcing `checking` gives the UI a stable
   * "we're not actually streaming right now" signal.
   *
   * Side-effects:
   *   - Resets `lastBps` / the RTT window so the next published
   *     value isn't "stuck at 4 Mbps / 3 bars" while the link is
   *     dying.
   *   - Resets the byte-counter snapshot so the bitrate measurement
   *     restarts cleanly from the next tick (otherwise we'd diff
   *     against stale, pre-degradation counters).
   *   - Bypasses the dedup so the listener fires even if we were
   *     already on `'checking'`.
   *
   * Safe to call when not started (no listener / no pc) - it's a
   * no-op in that case. Idempotent.
   */
  markChecking(): void {
    if (!this.listener) return;
    this.lastKind = 'checking';
    this.lastBps = null;
    this.lastRemoteIp = null;
    this.lastLevel = linkQualityLevel(null, 'checking');
    this.rttWindowMs = [];
    this.prevBytesSent = -1;
    this.prevBytesRecv = -1;
    this.prevSampleTs = 0;
    try {
      this.listener({ kind: 'checking', bps: null, remoteIp: null, rttMs: null });
    } catch (err) {
      console.warn('[transport] onTransportChange listener threw:', err);
    }
  }

  private async tick(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    // `getStats()` on a closed PC rejects with `InvalidStateError` on
    // some engines (Safari, older Chromium) and resolves with empty
    // stats on others. Either way it's noise: the host always calls
    // `stop()` on teardown, but ticks already queued before that can
    // still fire one last time - and now that the SDK retains the
    // PC briefly across the ICE grace window, the race is slightly
    // wider. Bail early when we know the underlying PC is dead.
    if (pc.connectionState === 'closed' || pc.signalingState === 'closed') {
      return;
    }
    try {
      const stats = await pc.getStats();
      const bps = this.sampleBitrate(stats);
      const rttMs = this.sampleRttMinMs(stats);
      const { kind, remoteIp: remoteIpFromStats } = analyzeSelectedPair(stats, { rttMs });
      // SDP fallback: iOS WKWebView (and some older Chromium builds)
      // don't expose the `address` / `ip` field on `RTCIceCandidate`
      // stats - the spec made it optional and Safari leaves it out.
      // In those cases `remoteIpFromStats` is `null` even though the
      // peer is happily connected; reading the SDP directly gives us
      // the same address the browser used to dial out, no permission
      // dance required. Skipped for `relay` (would surface the TURN
      // server, not the robot) and `checking` (no point yet).
      let remoteIp = remoteIpFromStats;
      if (!remoteIp && kind !== 'checking' && kind !== 'relay') {
        remoteIp = extractRobotHostIp(pc.remoteDescription?.sdp ?? null);
      }
      this.show(kind, bps, remoteIp, rttMs);
    } catch (err) {
      console.warn('[transport] getStats failed:', err);
    }
  }

  private show(
    kind: TransportKind,
    bps: number | null,
    remoteIp: string | null,
    rttMs: number | null,
  ): void {
    // Dedup on the rounded bitrate so micro-fluctuations don't fire the
    // listener every tick. ~0.1 kbps granularity is more than enough for
    // the UI - the badge formats to one decimal. `remoteIp` is included
    // in the dedup so a late-arriving address (Chromium resolves mDNS a
    // few ticks after nomination) actually triggers a re-render. The
    // quality LEVEL (not raw `rttMs`) is in the dedup too, so the signal
    // bars re-render when latency crosses a bar boundary but not on
    // every sub-threshold RTT jitter tick.
    const roundedBps = bps === null ? null : Math.round(bps / 100) * 100;
    const level = linkQualityLevel(rttMs, kind);
    if (
      kind === this.lastKind &&
      roundedBps === this.lastBps &&
      remoteIp === this.lastRemoteIp &&
      level === this.lastLevel
    ) {
      return;
    }
    this.lastKind = kind;
    this.lastBps = roundedBps;
    this.lastRemoteIp = remoteIp;
    this.lastLevel = level;
    if (this.listener) {
      try {
        this.listener({ kind, bps, remoteIp, rttMs });
      } catch (err) {
        // Listener errors must never tear down the engine.
        console.warn('[transport] onTransportChange listener threw:', err);
      }
    }
  }

  /**
   * Sample the cumulative byte counters and return the instantaneous
   * bitrate (bits per second) since the previous tick, or `null` while
   * we don't have two samples yet.
   *
   * We prefer reading `bytesSent` / `bytesReceived` from the selected
   * candidate-pair (Chromium / Firefox). When that's missing (Safari)
   * we fall back to summing the inbound/outbound RTP reports.
   */
  private sampleBitrate(stats: RTCStatsReport): number | null {
    let bytesSent = 0;
    let bytesRecv = 0;
    let nowTs = 0;

    let foundOnPair = false;
    stats.forEach((report) => {
      if (report.type !== 'candidate-pair') return;
      const pair = report as RTCStatsWithCandidates & {
        bytesSent?: number;
        bytesReceived?: number;
        selected?: boolean;
        timestamp?: number;
      };
      const isSelected =
        pair.selected === true ||
        (pair.nominated === true && pair.state === 'succeeded');
      if (!isSelected) return;
      if (
        typeof pair.bytesSent === 'number' &&
        typeof pair.bytesReceived === 'number'
      ) {
        bytesSent = pair.bytesSent;
        bytesRecv = pair.bytesReceived;
        nowTs = pair.timestamp ?? performance.now();
        foundOnPair = true;
      }
    });

    if (!foundOnPair) {
      stats.forEach((report) => {
        const r = report as {
          type: string;
          bytesSent?: number;
          bytesReceived?: number;
          timestamp?: number;
        };
        if (r.type === 'outbound-rtp' && typeof r.bytesSent === 'number') {
          bytesSent += r.bytesSent;
          nowTs = r.timestamp ?? nowTs;
        } else if (
          r.type === 'inbound-rtp' &&
          typeof r.bytesReceived === 'number'
        ) {
          bytesRecv += r.bytesReceived;
          nowTs = r.timestamp ?? nowTs;
        }
      });
    }

    if (!nowTs) nowTs = performance.now();

    let bps: number | null = null;
    if (this.prevSampleTs > 0 && this.prevBytesSent >= 0) {
      const dt = (nowTs - this.prevSampleTs) / 1000;
      if (dt > 0) {
        const dBytes =
          Math.max(0, bytesSent - this.prevBytesSent) +
          Math.max(0, bytesRecv - this.prevBytesRecv);
        bps = (dBytes * 8) / dt;
      }
    }

    this.prevBytesSent = bytesSent;
    this.prevBytesRecv = bytesRecv;
    this.prevSampleTs = nowTs;
    return bps;
  }

  /**
   * Read the selected candidate-pair's `currentRoundTripTime` and
   * return the rolling MIN over the recent window, in milliseconds.
   * Returns `null` when the platform doesn't expose RTT (iOS WKWebView
   * often omits it) - the classifier then simply ignores the RTT
   * signal and leans on addressing. The min is the robust read: see
   * {@link RTT_WINDOW_SIZE}.
   */
  private sampleRttMinMs(stats: RTCStatsReport): number | null {
    let rttMsSample: number | null = null;
    stats.forEach((report) => {
      if (report.type !== 'candidate-pair') return;
      const pair = report as RTCStatsWithCandidates & {
        selected?: boolean;
        currentRoundTripTime?: number;
      };
      const isSelected =
        pair.selected === true ||
        (pair.nominated === true && pair.state === 'succeeded');
      if (!isSelected) return;
      if (typeof pair.currentRoundTripTime === 'number') {
        rttMsSample = pair.currentRoundTripTime * 1000;
      }
    });
    if (rttMsSample === null) return null;
    this.rttWindowMs.push(rttMsSample);
    if (this.rttWindowMs.length > RTT_WINDOW_SIZE) this.rttWindowMs.shift();
    return Math.min(...this.rttWindowMs);
  }
}

/**
 * Walk the RTCStatsReport and return a human-readable classification
 * of the selected ICE candidate pair AND the remote candidate's
 * address (the robot's IP, from this peer's point of view).
 *
 * Classification rules
 * ────────────────────
 *
 *   relay   - either side uses a TURN-relayed candidate. The audio
 *             flows through a third-party relay (worst latency).
 *
 *   lan     - both sides use `host` candidates AND at least one of
 *             three signals confirms a same-link pair (see the inline
 *             block at the decision site):
 *               1. both addresses provably private (RFC1918, IPv6
 *                  ULA / link-local, loopback, `.local`);
 *               2. both addresses share a routing prefix (IPv6 /64 or
 *                  IPv4 /24) - rescues native-v6 homes (Free, Orange)
 *                  where two public GUAs sit on the same delegated
 *                  /64, which signal (1) alone would reject;
 *               3. a sub-few-ms RTT floor (`opts.rttMs`) - a
 *                  hardware-level same-L2 proof for when the address
 *                  is unreadable (Safari).
 *             The `host` type alone is NOT enough: ICE marks any
 *             candidate bound to a local interface as `host`, incl.
 *             ones carrying a publicly-routable IP, so a bare
 *             "host + host" with none of (1)-(3) is genuine
 *             peer-to-peer over the internet → `direct`.
 *
 *   direct  - peer-to-peer without a relay, but at least one address
 *             is publicly routable (or we can't read it, so we
 *             downgrade prudently rather than overstate LAN).
 *             Includes the STUN-discovered case (`srflx` / `prflx`)
 *             and the "host candidate on a public IP" case described
 *             above.
 *
 * `remoteIp` is `null` when no pair has been nominated yet, when the
 * platform doesn't expose the candidate address (Safari) or when the
 * remote candidate references a TURN relay (the relay's address isn't
 * the robot's - misleading to expose).
 */
export function analyzeSelectedPair(
  stats: RTCStatsReport,
  opts: {
    /**
     * Rolling-min RTT (ms) on the selected pair, when the platform
     * exposes it. A sub-{@link LAN_RTT_MAX_MS} floor upgrades a
     * host↔host pair to `lan` even when the addresses don't prove it
     * (Safari strips them, or they're public IPv6). Omitted / `null`
     * → the RTT signal is simply not consulted.
     */
    rttMs?: number | null;
  } = {},
): { kind: TransportKind; remoteIp: string | null } {
  // Stats shape: `candidate-pair`s reference `local-candidate` and
  // `remote-candidate` entries by id. The "selected" pair is the one
  // marked nominated + succeeded (and ideally `selected === true`, but
  // that flag is only set by Chrome).
  let selectedPair: RTCStatsWithCandidates | null = null;
  const candidates = new Map<string, RTCIceCandidateStat>();

  stats.forEach((report) => {
    if (
      report.type === 'local-candidate' ||
      report.type === 'remote-candidate'
    ) {
      candidates.set(report.id, report as RTCIceCandidateStat);
    }
    if (report.type === 'candidate-pair') {
      const pair = report as RTCStatsWithCandidates;
      const isSelected =
        (pair as { selected?: boolean }).selected === true ||
        (pair.nominated === true && pair.state === 'succeeded');
      if (!isSelected) return;
      // Prefer the explicitly `selected` one if multiple look nominated.
      if (!selectedPair || (pair as { selected?: boolean }).selected) {
        selectedPair = pair;
      }
    }
  });

  if (!selectedPair) return { kind: 'checking', remoteIp: null };
  const pair = selectedPair as RTCStatsWithCandidates;

  const local = pair.localCandidateId
    ? candidates.get(pair.localCandidateId)
    : undefined;
  const remote = pair.remoteCandidateId
    ? candidates.get(pair.remoteCandidateId)
    : undefined;

  const localType = local?.candidateType;
  const remoteType = remote?.candidateType;
  const remoteAddr = remote?.address ?? remote?.ip ?? null;

  if (localType === 'relay' || remoteType === 'relay') {
    // The remote-candidate address on the relay path is the TURN
    // server, not the robot. Don't surface it - it would confuse a
    // user trying to SSH into "the robot's IP".
    return { kind: 'relay', remoteIp: null };
  }
  if (localType !== 'host' || remoteType !== 'host') {
    return { kind: 'direct', remoteIp: remoteAddr };
  }

  // Both sides are `host`, but that's only "candidate bound to a
  // local interface" - the underlying IP can still be publicly
  // routable (IPv6 globals, public v4). We confirm a genuine LAN via
  // three independent signals, ANY of which is sufficient:
  //
  //   1. addressing  - both addresses provably private (RFC1918 /
  //                    IPv6 ULA / link-local / `.local`). The
  //                    strictest, privacy-grade proof: the data path
  //                    never leaves the local network.
  //   2. same prefix - both addresses share a routing prefix
  //                    (IPv6 /64 or IPv4 /24). Catches native-v6
  //                    homes (Free / Orange) where two PUBLIC GUAs
  //                    sit on the single ISP-delegated /64, which (1)
  //                    rejects despite being genuinely same-link.
  //   3. RTT floor   - a sub-few-ms rolling-min RTT, a hardware-level
  //                    "same L2" proof independent of addressing, for
  //                    the cases (1)/(2) can't read (Safari strips
  //                    the address entirely).
  //
  // (1) is authoritative for privacy; (2)/(3) only ever rescue false
  // negatives, never overstate (relay was already excluded above).
  const localAddr = local?.address ?? local?.ip;
  const lanByAddress =
    isPrivateAddress(localAddr) && isPrivateAddress(remoteAddr ?? undefined);
  const lanByPrefix = sameRoutingPrefix(localAddr, remoteAddr ?? undefined);
  const lanByRtt = typeof opts.rttMs === 'number' && opts.rttMs <= LAN_RTT_MAX_MS;
  if (lanByAddress || lanByPrefix || lanByRtt) {
    return { kind: 'lan', remoteIp: remoteAddr };
  }
  return { kind: 'direct', remoteIp: remoteAddr };
}

/**
 * Backward-compatible wrapper around {@link analyzeSelectedPair}.
 * Kept exported because earlier call sites (and tests) used it
 * directly. New code should prefer `analyzeSelectedPair` so it can
 * pick up the remote address alongside the classification.
 */
export function selectedTransportKind(stats: RTCStatsReport): TransportKind {
  return analyzeSelectedPair(stats).kind;
}

/**
 * Conservative "is this address provably on a private / local
 * network?" check. Returns `false` whenever we can't read the
 * address (Safari privacy, missing field) so the caller falls back
 * to the safer `direct` classification instead of overstating LAN.
 *
 * Recognised as private:
 *   - mDNS hostnames (`*.local`, with or without trailing dot).
 *     These are by construction LAN-only - mDNS doesn't traverse
 *     routers, so a `.local` hostname being resolvable AT ALL means
 *     the pair sits on the same broadcast domain. Chrome / Firefox
 *     use these by default for host-candidate privacy.
 *   - IPv4 RFC1918   (10/8, 172.16-31/12, 192.168/16).
 *   - IPv4 link-local (169.254/16).
 *   - IPv4 loopback   (127/8).
 *   - IPv6 loopback (::1), link-local (fe80::/10), ULA (fc00::/7).
 *   - IPv4-mapped IPv6 (`::ffff:a.b.c.d`) where the embedded v4 is
 *     itself in one of the v4 private ranges above.
 *
 * NOT recognised as private (treated as public → `direct`):
 *   - Publicly-routable IPv4 (anything outside the ranges above).
 *   - IPv6 GUA (anything outside fe80::/10 or fc00::/7), including
 *     the very common case of an ISP-assigned native v6 prefix that
 *     reaches the robot directly without NAT but absolutely DOES go
 *     over the internet.
 *   - CGNAT 100.64/10 - it's ISP-shared, not user-LAN. We mark it
 *     `direct` so the badge reflects that there's a non-LAN hop.
 */
function isPrivateAddress(addr: string | undefined): boolean {
  if (!addr) return false;

  // mDNS hostname - Chrome / Firefox privacy default. Trailing dot
  // is sometimes there, sometimes not, depending on the engine.
  const normalised = addr.toLowerCase();
  if (normalised.endsWith('.local') || normalised.endsWith('.local.')) {
    return true;
  }

  // IPv4 (or IPv4-mapped IPv6 with the leading `::ffff:`).
  const v4Source = normalised.startsWith('::ffff:')
    ? normalised.slice('::ffff:'.length)
    : normalised;
  if (isPrivateIpv4(v4Source)) return true;

  // IPv6 loopback / link-local / ULA.
  if (normalised === '::1') return true;
  // fe80::/10 → first byte 0xfe AND top 2 bits of next byte == 10,
  // i.e. nibble [2] ∈ {8, 9, a, b}. Match the hex literal prefix.
  if (/^fe[89ab]/i.test(normalised)) return true;
  // fc00::/7 → first byte 0xfc or 0xfd. Match the hex literal prefix.
  if (/^f[cd]/i.test(normalised)) return true;

  return false;
}

function isPrivateIpv4(addr: string): boolean {
  // Quick shape check - we only care about plain `a.b.c.d`; anything
  // else (zone ids, hostnames that snuck in) falls through to false.
  const parts = addr.split('.');
  if (parts.length !== 4) return false;
  const oct = parts.map((p) => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255 ? n : -1;
  });
  if (oct.some((n) => n < 0)) return false;
  const [a, b] = oct;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

/**
 * Whether two candidate addresses sit on the same link, by comparing
 * their routing prefix: IPv4 /24 (first three octets) or IPv6 /64
 * (first four hextets).
 *
 * This is what upgrades a host↔host pair over two PUBLIC IPv6 GUAs to
 * `lan`: on a native-v6 home both devices get addresses inside the
 * single /64 the ISP delegates, so an equal /64 is a strong "same
 * broadcast domain" signal that `isPrivateAddress` (rightly) rejects.
 *
 * Returns `false` whenever either address is missing or not a literal
 * IP (e.g. a `.local` mDNS hostname) - those are handled by
 * `isPrivateAddress` instead, so we never overstate LAN here.
 */
function sameRoutingPrefix(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;

  const a4 = asIpv4(a);
  const b4 = asIpv4(b);
  if (a4 && b4) {
    return a4.split('.').slice(0, 3).join('.') === b4.split('.').slice(0, 3).join('.');
  }

  const a6 = ipv6Prefix64(a);
  const b6 = ipv6Prefix64(b);
  return a6 !== null && a6 === b6;
}

/**
 * Extract a dotted-quad IPv4 string from an address that may be a
 * plain v4 or an IPv4-mapped IPv6 (`::ffff:a.b.c.d`). Returns `null`
 * for anything that isn't v4-shaped (incl. `.local` hostnames).
 */
function asIpv4(addr: string): string | null {
  const a = addr.toLowerCase();
  const v4 = a.startsWith('::ffff:') ? a.slice('::ffff:'.length) : a;
  const parts = v4.split('.');
  if (parts.length !== 4) return null;
  const valid = parts.every((p) => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
  return valid ? v4 : null;
}

/**
 * Normalise an IPv6 literal and return its /64 prefix (first four
 * 16-bit groups, leading zeros stripped, `:`-joined), or `null` if the
 * input isn't parseable IPv6. Handles `::` zero-run expansion and an
 * optional `%zone` suffix; bails (returns `null`) on embedded-IPv4 or
 * malformed forms rather than guessing.
 */
function ipv6Prefix64(addr: string): string | null {
  let s = addr.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(':')) return null;

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];

  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const prefix = groups.slice(0, 4).map((g) => {
    const n = parseInt(g || '0', 16);
    return Number.isNaN(n) ? null : n.toString(16);
  });
  return prefix.some((g) => g === null) ? null : prefix.join(':');
}

/**
 * Extract the robot's most-likely-reachable host IP from the SDP the
 * peer sent us. Used as a fallback when `RTCIceCandidate` stats don't
 * expose `address` (iOS WKWebView, older Chromium).
 *
 * Strategy:
 *   - parse every `a=candidate:… typ host …` line of the SDP;
 *   - prefer addresses we recognise as private (RFC1918, IPv6 ULA,
 *     etc.) so we surface the LAN IP the user actually wants for SSH,
 *     not the public reflection of the same NIC if both happen to be
 *     advertised;
 *   - among the private addresses, prefer IPv4 over IPv6 to match the
 *     mental model of a typical user reading the topbar
 *     ("192.168.x.y" is friendlier than a v6 ULA);
 *   - fall back to the first listed host candidate when no private
 *     match is found (better an honest public IP than `null`);
 *   - return `null` when the SDP has no host candidate at all (which
 *     happens when the robot only advertises srflx / relay - in that
 *     case there's no addressable LAN address to surface anyway).
 *
 * Pure function: takes the raw SDP string and returns a host IP or
 * null. No DOM / stats dependency, so it's trivial to unit-test if
 * the need arises.
 */
function extractRobotHostIp(sdp: string | null): string | null {
  if (!sdp) return null;

  // SDP candidate line shape (RFC 5245 / 8839):
  //
  //   a=candidate:foundation component transport priority
  //              connection-address port typ <type> [...]
  //
  // We only care about `typ host` - the address right before that
  // marker is the candidate's IP / hostname. We deliberately ignore
  // srflx / prflx / relay because their `connection-address` is the
  // STUN/TURN reflection, not the robot's own NIC.
  const hostIps: string[] = [];
  const re = /^a=candidate:\S+\s+\d+\s+\S+\s+\d+\s+(\S+)\s+\d+\s+typ\s+host\b/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sdp)) !== null) {
    const ip = m[1];
    if (ip) hostIps.push(ip);
  }
  if (hostIps.length === 0) return null;

  const privateIps = hostIps.filter((ip) => isPrivateAddress(ip));
  if (privateIps.length > 0) {
    const v4 = privateIps.find((ip) => ip.includes('.') && !ip.includes(':'));
    return v4 ?? privateIps[0];
  }
  return hostIps[0];
}
