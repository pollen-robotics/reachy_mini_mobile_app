/**
 * iOS phone-microphone release helper.
 *
 * Stops every audio track captured by the SDK's `_micStream` so the
 * iOS audio session lets go of its "phone mic captured" claim once
 * the realtime bridge has swapped the WebRTC sender for the assistant
 * audio track.
 *
 * Background. The vendored SDK calls `getUserMedia({audio:true})`
 * during `startSession()` (`_enableMicrophone: true`) and stashes
 * the resulting MediaStream as `_micStream`, then attaches its
 * tracks to the WebRTC `_pc` as audio senders. Even though we
 * immediately swap those senders' tracks for the assistant output via
 * `audioSender.replaceTrack(...)` and the SDK's tracks have
 * `enabled = false` from creation, iOS still considers the phone
 * mic "captured" by the app for as long as a non-stopped
 * MediaStreamTrack from `getUserMedia({audio})` is alive. Result:
 * the orange mic indicator in the status bar stays lit while the
 * user is on the Apps / Robot tab (or with the app backgrounded),
 * even though no audio is actually being recorded from the phone.
 *
 * Stopping the captured tracks here releases the iOS audio
 * session's mic claim. The WebRTC sender is unaffected because the
 * bridge already swapped it for the assistant track above; the tracks
 * we're stopping are dangling references the SDK no longer pumps
 * data into. Idempotent against subsequent `runConversationParts()`
 * calls (a re-acquire after release): the SDK regenerates
 * `_micStream` on every `startSession`, so this stop runs exactly
 * once per session.
 *
 * Reaches into a private SDK field; the cast is intentional. We
 * accept the coupling because the alternative (forking the npm SDK
 * to add a public `releaseLocalMic()`) would force us to pin a
 * fork instead of `@pollen-robotics/reachy-mini-sdk`. If the field
 * is renamed in a future SDK bump, this becomes a silent no-op
 * (the `?? null` guard) and the iOS mic indicator regression
 * resurfaces - which is observable by inspection on TestFlight,
 * easy to spot and fix.
 */

import type { ReachyMiniInstance } from "@/features/robot-session/sdk-types";

export function releaseSdkPhoneMic(
  robotInstance: ReachyMiniInstance | null,
): void {
  if (!robotInstance) return;
  const sdkInternal = robotInstance as unknown as {
    _micStream?: MediaStream | null;
  };
  const stream = sdkInternal._micStream ?? null;
  if (!stream) return;
  for (const track of stream.getAudioTracks()) {
    try {
      track.stop();
    } catch {
      // The track may already have been stopped by an interleaved
      // SDK teardown (rare, but possible if the user power-offs
      // mid-handshake). Nothing to do.
    }
  }
}
