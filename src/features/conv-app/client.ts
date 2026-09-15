/**
 * Typed client for the conversation app running on the robot, over the SDK's
 * JSON-RPC (`rpcCall`, relayed by the daemon across the WebRTC data channel —
 * the phone has no LAN route to the app's :7860).
 *
 * Two namespaces, two owners. `apps.*` is the daemon's app lifecycle and
 * answers whether the robot is running anything at all. `conversation.*` is
 * relayed to the app itself and only answers while it runs; when it does not,
 * the relay rejects with reason `not_running`.
 *
 * Shapes come from the conv app's `console.py` and the daemon's
 * `jsonrpc_relay.py`.
 */
import type {
  ReachyMiniInstance,
  RpcNotificationHandler,
} from '@/features/robot-session/sdk-types';

/** Entry-point name the daemon installs and starts the app under. */
export const CONV_APP_NAME = 'reachy_mini_conversation_app';

/** `apps.start` covers a cold start of the app's Python process. */
const START_TIMEOUT_MS = 60_000;
/** A first install pulls the app from the Hub; minutes, not seconds. */
const INSTALL_TIMEOUT_MS = 300_000;
/** Stopping should be prompt, but must not hang a power-off. */
const STOP_TIMEOUT_MS = 15_000;

/** The readiness fields of `conversation.status` (it carries more). */
export interface ConvAppStatus {
  /** False until the app's own voice backend is up: the real readiness. */
  backend_connected: boolean;
  /** Why the backend is not connected, when it is not. */
  backend_error: string | null;
  /** False when the robot itself is not signed in to Hugging Face. */
  has_hf_connection: boolean;
}

/** `apps.status`: `state` is `idle` when the robot runs nothing. */
export interface CurrentAppStatus {
  state?: string;
  error?: string | null;
  info?: { name?: string } | null;
}

export interface ConvAppClient {
  // Daemon-side app lifecycle.
  getCurrentAppStatus(): Promise<CurrentAppStatus>;
  startConvApp(): Promise<void>;
  /** Stops whatever app holds the robot, not only the conversation app. */
  stopRunningApp(): Promise<void>;
  installConvApp(): Promise<void>;

  // The running conversation app.
  getStatus(): Promise<ConvAppStatus>;
  setMicMuted(muted: boolean): Promise<boolean>;

  /** Subscribe to a notification; returns an unsubscribe function. */
  on(event: string, handler: RpcNotificationHandler): () => void;
}

export function createConvAppClient(robot: ReachyMiniInstance): ConvAppClient {
  return {
    getCurrentAppStatus() {
      return robot.rpcCall<CurrentAppStatus>('apps.status');
    },
    async startConvApp() {
      await robot.rpcCall('apps.start', { name: CONV_APP_NAME }, { timeoutMs: START_TIMEOUT_MS });
    },
    async stopRunningApp() {
      await robot.rpcCall('apps.stop', {}, { timeoutMs: STOP_TIMEOUT_MS });
    },
    async installConvApp() {
      await robot.rpcCall(
        'apps.install',
        { name: CONV_APP_NAME },
        { timeoutMs: INSTALL_TIMEOUT_MS }
      );
    },

    getStatus() {
      return robot.rpcCall<ConvAppStatus>('conversation.status');
    },
    async setMicMuted(muted) {
      return (await robot.rpcCall<{ muted: boolean }>('conversation.mic', { muted })).muted;
    },

    on(event, handler) {
      return robot.onNotification(event, handler);
    },
  };
}
