/**
 * Public API of the conversation module.
 *
 * The host imports `ConversationPanel` and treats the rest of the
 * module as a black box. Everything else under this directory is an
 * internal implementation detail (the engine, the motion modules,
 * the orb, HF realtime wiring, memory, permissions). Do NOT
 * re-export internal types from here unless they're part of the
 * documented host contract.
 *
 * The module is fully self-contained:
 *   - It owns its own ReachyMini SDK instance (created inside the
 *     engine's `boot()` path).
 *   - It opens its own WebRTC + DataChannel session against the HF
 *     central relay, using the token + preselected peer id passed
 *     in by the host.
 *   - It handles the HF realtime audio bridge (robot mic ↔ AI ↔
 *     robot speaker) via a backend WebSocket.
 *   - It plays robot-side motion (head wobble, antennas, tool-call
 *     dances) over the SDK's data channel.
 *   - It teardown cleanly on unmount: closes the realtime backend,
 *     stops the SDK session, releases motors via `goto_sleep`.
 *
 * Configuration: the engine uses the app-managed Hugging Face
 * realtime session allocator by default, or a direct websocket when
 * configured in `shared/env.ts`. No build-time model-provider secret
 * is required.
 */

export type {
  ConnectionState,
  ConversationState,
  ConversationConnectionAttempt,
} from './engine/conversation-engine';
export { flushEngineLifecycle } from '@/features/robot-session/lifecycle-queue';
