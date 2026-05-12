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

export class TransportMonitor {
  private pc: RTCPeerConnection | null = null;
  private timer: number | null = null;
  private lastKind: TransportKind | null = null;
  private lastBps: number | null = null;
  private lastRemoteIp: string | null = null;
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
    this.show('checking', null, null);
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
    this.prevBytesSent = -1;
    this.prevBytesRecv = -1;
    this.prevSampleTs = 0;
  }

  private async tick(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    try {
      const stats = await pc.getStats();
      const bps = this.sampleBitrate(stats);
      const { kind, remoteIp: remoteIpFromStats } = analyzeSelectedPair(stats);
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
      this.show(kind, bps, remoteIp);
    } catch (err) {
      console.warn('[transport] getStats failed:', err);
    }
  }

  private show(
    kind: TransportKind,
    bps: number | null,
    remoteIp: string | null,
  ): void {
    // Dedup on the rounded bitrate so micro-fluctuations don't fire the
    // listener every tick. ~0.1 kbps granularity is more than enough for
    // the UI - the badge formats to one decimal. `remoteIp` is included
    // in the dedup so a late-arriving address (Chromium resolves mDNS a
    // few ticks after nomination) actually triggers a re-render.
    const roundedBps = bps === null ? null : Math.round(bps / 100) * 100;
    if (
      kind === this.lastKind &&
      roundedBps === this.lastBps &&
      remoteIp === this.lastRemoteIp
    ) {
      return;
    }
    this.lastKind = kind;
    this.lastBps = roundedBps;
    this.lastRemoteIp = remoteIp;
    if (this.listener) {
      try {
        this.listener({ kind, bps, remoteIp });
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
 *   lan     - both sides use `host` candidates AND both addresses are
 *             provably private (RFC1918, IPv6 ULA / link-local,
 *             loopback, or an mDNS `.local` hostname). The `host`
 *             type alone is NOT enough: ICE marks any candidate bound
 *             to a local interface as `host`, including ones that
 *             carry a publicly-routable IPv6 (common with native v6
 *             at French ISPs - Free, Orange) or even a public IPv4.
 *             A "host + host" pair on those addresses is genuine
 *             peer-to-peer over the internet, not LAN.
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
  // routable (IPv6 globals, public v4). Verify the actual addresses
  // before claiming LAN.
  const localAddr = local?.address ?? local?.ip;
  if (isPrivateAddress(localAddr) && isPrivateAddress(remoteAddr ?? undefined)) {
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
