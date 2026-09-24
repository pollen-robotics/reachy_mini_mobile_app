/**
 * Telepresence audio legs, both riding the EXISTING robot peer
 * connection (no second session, no renegotiation):
 *
 *   phone mic ──getUserMedia──▶ replaceTrack(audio sender) ──▶ robot speaker
 *   robot mic ──audio receiver track──▶ <audio> element     ──▶ phone speaker
 *
 * Outgoing (phone → robot). The audio sender normally carries the
 * conversation's AI voice (see `huggingface-bridge.routeOutputToRobot`)
 * or the SDK's silent placeholder. We swap the real phone mic onto it
 * and hand the previous track back on `dispose()`, so a conversation
 * started afterwards finds the sender exactly as it left it (it re-routes
 * its own track on start anyway). Capture is lazy: the first unmute must
 * be a user gesture on iOS or the permission prompt never shows.
 *
 * Incoming (robot → phone). The robot mic is the pc's audio receiver
 * track. The conversation engine may have left it `enabled = false` (its
 * mic gate), so we force it on while telepresence plays it and restore
 * the previous flag on dispose. The video element stays muted: audio
 * goes through our own element so mute/unmute never touches the camera.
 *
 * Both legs expose `ensure()`, polled by the hook: an SDK auto re-dial
 * replaces the pc and strands tracks on the dead one, and the engine's
 * own re-dial rebind can flip the sender / receiver state underneath us.
 */
import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';

function findAudioTransceiver(pc: RTCPeerConnection): RTCRtpTransceiver | null {
  return (
    pc
      .getTransceivers()
      .find((t) => t.receiver.track?.kind === 'audio' || t.sender.track?.kind === 'audio') ??
    null
  );
}

function findRobotMicTrack(pc: RTCPeerConnection): MediaStreamTrack | null {
  for (const receiver of pc.getReceivers()) {
    if (receiver.track?.kind === 'audio') return receiver.track;
  }
  return null;
}

// ─── Phone mic → robot speaker ───────────────────────────────────────

export interface PhoneMicLink {
  readonly stream: MediaStream;
  setMuted(muted: boolean): void;
  /**
   * Make sure the mic is (still) what the robot's audio sender carries.
   * Cheap when nothing changed; re-binds after an SDK re-dial (new pc) or
   * if something else (e.g. the conversation bridge re-routing a stale AI
   * track after a re-dial) swapped the sender's track underneath us.
   */
  ensure(robot: ReachyMiniInstance): Promise<void>;
  /** Stop the mic (releases the OS indicator) + restore the sender. Idempotent. */
  dispose(): Promise<void>;
}

export async function attachPhoneMic(robot: ReachyMiniInstance): Promise<PhoneMicLink> {
  if (!robot.peerConnection) throw new Error('no robot peer connection');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const micTrack = stream.getAudioTracks()[0];
  if (!micTrack) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('getUserMedia returned no audio track');
  }

  let sender: RTCRtpSender | null = null;
  let previousTrack: MediaStreamTrack | null = null;
  let disposed = false;

  const bindTo = async (pc: RTCPeerConnection): Promise<void> => {
    const transceiver = findAudioTransceiver(pc);
    if (!transceiver) throw new Error('robot peer has no audio transceiver');
    if (transceiver.direction !== 'sendrecv' && transceiver.direction !== 'sendonly') {
      try {
        transceiver.direction = 'sendrecv';
      } catch {
        /* best effort, same as the conversation bridge */
      }
    }
    if (transceiver.sender === sender && sender?.track === micTrack) return;
    if (transceiver.sender !== sender) {
      sender = transceiver.sender;
      previousTrack = sender.track === micTrack ? previousTrack : sender.track;
    }
    await sender.replaceTrack(micTrack);
  };

  try {
    await bindTo(robot.peerConnection);
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    throw err;
  }

  return {
    stream,
    setMuted(muted) {
      if (!disposed) micTrack.enabled = !muted;
    },
    async ensure(r) {
      if (disposed || !r.peerConnection) return;
      await bindTo(r.peerConnection).catch((err) =>
        console.warn('[telepresence] mic rebind failed:', err),
      );
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        await sender?.replaceTrack(previousTrack);
      } catch {
        /* pc may already be closed */
      }
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

// ─── Robot mic → phone speaker ───────────────────────────────────────

export interface RobotAudioPlayer {
  /** Resolves false when the WebView refused audible playback (autoplay policy). */
  setMuted(muted: boolean): Promise<boolean>;
  /**
   * Make sure we play the pc's CURRENT receiver track and that it's
   * enabled (the engine's mic gate / re-dial rebind may flip it). Cheap
   * when nothing changed. Returns false if there's no audio receiver.
   */
  ensure(robot: ReachyMiniInstance): boolean;
  dispose(): void;
}

export function createRobotAudioPlayer(): RobotAudioPlayer {
  const el = document.createElement('audio');
  el.autoplay = true;
  el.muted = true;
  el.setAttribute('playsinline', '');
  document.body.appendChild(el);

  let track: MediaStreamTrack | null = null;
  let trackWasEnabled = true;

  const release = () => {
    if (track) track.enabled = trackWasEnabled;
    track = null;
  };

  return {
    async setMuted(muted) {
      el.muted = muted;
      // Nothing bound yet: `ensure()` starts playback once a track lands.
      if (muted || !el.srcObject) return true;
      try {
        await el.play();
        return true;
      } catch (err) {
        console.warn('[telepresence] robot audio playback blocked:', err);
        el.muted = true;
        return false;
      }
    },
    ensure(robot) {
      const pc = robot.peerConnection;
      const next = pc ? findRobotMicTrack(pc) : null;
      if (!next) return false;
      if (next === track && !next.enabled) next.enabled = true;
      if (next !== track) {
        release();
        track = next;
        trackWasEnabled = next.enabled;
        next.enabled = true;
        el.srcObject = new MediaStream([next]);
        if (!el.muted) void el.play().catch(() => {});
      }
      return true;
    },
    dispose() {
      release();
      el.srcObject = null;
      el.remove();
    },
  };
}
