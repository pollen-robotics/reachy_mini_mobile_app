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

interface RTCIceCandidateStat {
  id: string;
  candidateType?: 'host' | 'srflx' | 'prflx' | 'relay';
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
  // External listener wired via `start(pc, listener)`. Captured per
  // session and cleared on `stop()` so it can't leak to the next
  // engine mount when the singleton is reused.
  private listener: ((kind: TransportKind) => void) | null = null;
  // Last snapshot of cumulative byte counters so we can diff against the
  // next tick and compute a bitrate. -1 means "no prior sample yet".
  private prevBytesSent = -1;
  private prevBytesRecv = -1;
  private prevSampleTs = 0;

  start(
    pc: RTCPeerConnection,
    listener: ((kind: TransportKind) => void) | null = null,
  ): void {
    this.stop();
    this.pc = pc;
    this.listener = listener;
    this.show('checking');
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
    this.prevBytesSent = -1;
    this.prevBytesRecv = -1;
    this.prevSampleTs = 0;
  }

  private async tick(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    try {
      const stats = await pc.getStats();
      this.show(selectedTransportKind(stats));
      // Bitrate sampling is kept for the side-effect of advancing the
      // running byte counters (they're useful if we ever re-introduce
      // a transport pill in the host UI). The values themselves are
      // only consumed for that future surface.
      this.sampleBitrate(stats);
    } catch (err) {
      console.warn('[transport] getStats failed:', err);
    }
  }

  private show(kind: TransportKind): void {
    if (kind === this.lastKind) return;
    this.lastKind = kind;
    if (this.listener) {
      try {
        this.listener(kind);
      } catch (err) {
        // Listener errors must never tear down the engine.
        console.warn('[transport] onTransportChange listener threw:', err);
      }
    }
  }

  /**
   * Advance the byte counters used to compute a future bitrate readout.
   * Stays a private helper because no host currently consumes it: when
   * we add a transport pill in React we'll surface the deltas via a
   * dedicated `onBitrate` callback rather than re-introducing DOM
   * mutation here.
   */
  private sampleBitrate(stats: RTCStatsReport): void {
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
    this.prevBytesSent = bytesSent;
    this.prevBytesRecv = bytesRecv;
    this.prevSampleTs = nowTs;
  }
}

/**
 * Walk the RTCStatsReport and return a human-readable classification
 * of the selected ICE candidate pair. Returns `checking` when no pair
 * has been nominated yet.
 */
export function selectedTransportKind(stats: RTCStatsReport): TransportKind {
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

  if (!selectedPair) return 'checking';
  const pair = selectedPair as RTCStatsWithCandidates;

  const local = pair.localCandidateId
    ? candidates.get(pair.localCandidateId)
    : undefined;
  const remote = pair.remoteCandidateId
    ? candidates.get(pair.remoteCandidateId)
    : undefined;

  const localType = local?.candidateType;
  const remoteType = remote?.candidateType;

  if (localType === 'relay' || remoteType === 'relay') return 'relay';
  if (localType === 'host' && remoteType === 'host') return 'lan';
  return 'direct';
}
