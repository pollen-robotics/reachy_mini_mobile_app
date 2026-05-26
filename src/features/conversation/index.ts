/**
 * Public API of the conversation module.
 *
 * The host imports `ConversationPanel` and treats the rest of the
 * module as a black box. Everything else under this directory is an
 * internal implementation detail (the engine, the motion modules,
 * the orb, OpenAI Realtime wiring, memory, permissions). Do NOT
 * re-export internal types from here unless they're part of the
 * documented host contract.
 *
 * The module is fully self-contained:
 *   - It owns its own ReachyMini SDK instance (created inside the
 *     engine's `boot()` path).
 *   - It opens its own WebRTC + DataChannel session against the HF
 *     central relay, using the token + preselected peer id passed
 *     in by the host.
 *   - It handles the OpenAI Realtime audio bridge (mic ↔ AI ↔
 *     robot speaker) via direct WebRTC to OpenAI.
 *   - It plays robot-side motion (head wobble, antennas, tool-call
 *     dances) over the SDK's data channel.
 *   - It teardown cleanly on unmount: closes the OpenAI peer,
 *     stops the SDK session, releases motors via `goto_sleep`.
 *
 * Configuration: the engine mints per-user OpenAI Realtime
 * ephemeral keys via the website's `/api/openai/ephemeral`
 * endpoint at conversation-start time (see `engine/ephemeral-key.ts`).
 * No build-time secret is required. The engine will surface a
 * "Sign in to Hugging Face" UI message if the user isn't
 * authenticated when they try to start a conversation; otherwise
 * the orb spins / motors engage and the AI voice comes online
 * after the SDP handshake.
 */

export type {
  AppState as ConversationState,
  ConversationConnectionAttempt,
} from './engine/conversation-engine';
export { flushEngineLifecycle } from '@/features/robot-session/lifecycle-queue';
