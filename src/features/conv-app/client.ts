/**
 * Typed client for the conversation app running on the robot, over the SDK's
 * JSON-RPC (`rpcCall`, relayed by the daemon across the WebRTC data channel —
 * the phone has no LAN route to the app's :7860).
 *
 * Two namespaces, two owners. `apps.*` is the daemon's app lifecycle and
 * answers whether the robot is running anything at all. Everything else is
 * relayed to the conversation app itself and only answers while it runs; when
 * it does not, the relay rejects with reason `not_running`.
 *
 * Shapes come from the conv app's `console.py`, `personality_routes.py`,
 * `memory_routes.py`, `language_routes.py`, `vision_routes.py` and the daemon's
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

/** One long-term memory fact, same shape the phone's memory panel renders. */
export interface MemoryFact {
  id: string;
  text: string;
  createdAt: number;
}

export interface MemoryList {
  facts: MemoryFact[];
  max_facts: number;
  enabled: boolean;
}

/** `conversation.status`: the app's own readiness plus the settings it owns. */
export interface ConvAppStatus {
  backend: string | null;
  backend_connected: boolean;
  backend_connection_state: string | null;
  backend_error: string | null;
  requires_restart: boolean;
  has_hf_connection: boolean;
  personality: string | null;
  voice: string | null;
  language: string | null;
  memory_enabled: boolean;
  vision_enabled: boolean;
}

/** One personality as the robot stores it. `name` is its canonical id. */
export interface RobotPersonality {
  name: string;
  avatar_id: string;
  instructions: string;
  greeting: string;
  voice: string;
  uses_default_voice: boolean;
  available_tools: string[];
  enabled_tools: string[];
}

export interface PersonalityCatalog {
  personalities: RobotPersonality[];
  current: string;
  startup: string;
  locked: boolean;
  locked_to?: string | null;
}

/** `apps.status`: `state` is `idle` when the robot runs nothing. */
export interface CurrentAppStatus {
  state?: string;
  error?: string | null;
  info?: { name?: string } | null;
}

export interface SavePersonalityInput {
  name: string;
  instructions: string;
  voice?: string;
  greeting?: string;
  overwrite?: boolean;
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
  getMicMuted(): Promise<boolean>;
  setMicMuted(muted: boolean): Promise<boolean>;
  interrupt(): Promise<void>;

  getPersonalities(): Promise<PersonalityCatalog>;
  applyPersonality(name: string, persist?: boolean): Promise<void>;
  savePersonality(input: SavePersonalityInput): Promise<string>;
  deletePersonality(name: string): Promise<void>;
  getPersonalityAvatar(name: string): Promise<string>;

  getVoices(): Promise<string[]>;
  applyVoice(voice: string): Promise<void>;

  listMemory(): Promise<MemoryList>;
  forgetMemory(fact: { id?: string; query?: string }): Promise<MemoryFact | null>;
  clearMemory(): Promise<void>;
  setMemoryEnabled(enabled: boolean): Promise<boolean>;

  getLanguage(): Promise<string>;
  setLanguage(language: string): Promise<string>;

  setVisionEnabled(enabled: boolean): Promise<boolean>;

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
    async getMicMuted() {
      return (await robot.rpcCall<{ muted: boolean }>('conversation.mic')).muted;
    },
    async setMicMuted(muted) {
      return (await robot.rpcCall<{ muted: boolean }>('conversation.mic', { muted })).muted;
    },
    async interrupt() {
      await robot.rpcCall('conversation.interrupt');
    },

    getPersonalities() {
      return robot.rpcCall<PersonalityCatalog>('personalities.all');
    },
    async applyPersonality(name, persist = true) {
      await robot.rpcCall('personalities.apply', { name, persist });
    },
    async savePersonality(input) {
      const saved = await robot.rpcCall<{ value: string }>('personalities.save', { ...input });
      return saved.value;
    },
    async deletePersonality(name) {
      await robot.rpcCall('personalities.delete', { name });
    },
    async getPersonalityAvatar(name) {
      return (await robot.rpcCall<{ svg: string }>('personalities.avatar', { name })).svg;
    },

    getVoices() {
      return robot.rpcCall<string[]>('voices.list');
    },
    async applyVoice(voice) {
      await robot.rpcCall('voices.apply', { voice });
    },

    listMemory() {
      return robot.rpcCall<MemoryList>('memory.list');
    },
    async forgetMemory(fact) {
      return (await robot.rpcCall<{ removed: MemoryFact | null }>('memory.forget', { ...fact }))
        .removed;
    },
    async clearMemory() {
      await robot.rpcCall('memory.clear');
    },
    async setMemoryEnabled(enabled) {
      return (await robot.rpcCall<{ enabled: boolean }>('memory.set_enabled', { enabled })).enabled;
    },

    async getLanguage() {
      return (await robot.rpcCall<{ language: string }>('language.get')).language;
    },
    async setLanguage(language) {
      return (await robot.rpcCall<{ language: string }>('language.set', { language })).language;
    },

    async setVisionEnabled(enabled) {
      return (await robot.rpcCall<{ enabled: boolean }>('vision.set', { enabled })).enabled;
    },

    on(event, handler) {
      return robot.onNotification(event, handler);
    },
  };
}
