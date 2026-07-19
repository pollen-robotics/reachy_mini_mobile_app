/**
 * Typed client for the on-robot conversation app, over the SDK's JSON-RPC
 * (`rpcCall`, relayed by the daemon across the WebRTC data channel — the phone
 * has no LAN route to :7860).
 *
 * `conversation.*` / `personalities.*` / `voices.*` drive the running app;
 * `apps.*` is the daemon's app lifecycle. Method + payload shapes come from the
 * conv app's `console.py` / `personality_routes.py` and the daemon relay.
 */
import type {
  ReachyMiniInstance,
  RpcNotificationHandler,
} from '@/features/robot-session/sdk-types';

export const CONV_APP_NAME = 'reachy_mini_conversation_app';

export interface ConvAppStatus {
  backend: string | null;
  backend_connected: boolean;
  backend_connection_state: string | null;
  backend_error: string | null;
  requires_restart: boolean;
}

export interface PersonalitiesInfo {
  choices: string[];
  current: string;
  startup: string;
  locked: boolean;
  locked_to?: string;
}

export interface CurrentAppStatus {
  info?: { name?: string } | null;
  state?: string;
}

export interface ConvAppClient {
  getStatus(): Promise<ConvAppStatus>;
  getMicMuted(): Promise<boolean>;
  setMicMuted(muted: boolean): Promise<boolean>;
  getPersonalities(): Promise<PersonalitiesInfo>;
  applyPersonality(name: string, persist?: boolean): Promise<void>;
  getVoices(): Promise<string[]>;
  getCurrentVoice(): Promise<string>;
  applyVoice(voice: string): Promise<void>;
  getCurrentAppStatus(): Promise<CurrentAppStatus>;
  startConvApp(): Promise<void>;
  stopConvApp(): Promise<void>;
  /** Install the conversation app on the robot if missing (no-op when
   *  already installed). A first install can take minutes. */
  installConvApp(): Promise<void>;
  /** Subscribe to a conversation.* event; returns an unsubscribe fn. */
  on(event: string, handler: RpcNotificationHandler): () => void;
}

export function createConvAppClient(robot: ReachyMiniInstance): ConvAppClient {
  return {
    getStatus() {
      return robot.rpcCall<ConvAppStatus>('conversation.status');
    },
    async getMicMuted() {
      return (await robot.rpcCall<{ muted: boolean }>('conversation.mic')).muted;
    },
    async setMicMuted(muted) {
      return (await robot.rpcCall<{ muted: boolean }>('conversation.mic', { muted })).muted;
    },
    getPersonalities() {
      return robot.rpcCall<PersonalitiesInfo>('personalities.list');
    },
    async applyPersonality(name, persist = true) {
      await robot.rpcCall('personalities.apply', { name, persist });
    },
    getVoices() {
      return robot.rpcCall<string[]>('voices.list');
    },
    async getCurrentVoice() {
      return (await robot.rpcCall<{ voice: string }>('voices.current')).voice;
    },
    async applyVoice(voice) {
      await robot.rpcCall('voices.apply', { voice });
    },
    getCurrentAppStatus() {
      return robot.rpcCall<CurrentAppStatus>('apps.status');
    },
    async startConvApp() {
      // Install + launch can take a while; allow more than the default timeout.
      await robot.rpcCall('apps.start', { name: CONV_APP_NAME }, { timeoutMs: 60000 });
    },
    async stopConvApp() {
      await robot.rpcCall('apps.stop');
    },
    async installConvApp() {
      await robot.rpcCall('apps.install', { name: CONV_APP_NAME }, { timeoutMs: 300_000 });
    },
    on(event, handler) {
      return robot.onNotification(event, handler);
    },
  };
}
