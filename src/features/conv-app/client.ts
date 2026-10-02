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
/** The robot's namespace for personalities a user wrote. */
const USER_PREFIX = 'user_personalities/';

/** `apps.start` covers a cold start of the app's Python process. */
const START_TIMEOUT_MS = 60_000;
/** A first install pulls the app from the Hub; minutes, not seconds. */
const INSTALL_TIMEOUT_MS = 300_000;
/** Stopping should be prompt, but must not hang a power-off. */
const STOP_TIMEOUT_MS = 15_000;

/** One personality as the robot stores it. `name` is its canonical id. */
export interface RobotPersonality {
  name: string;
  instructions: string;
  greeting: string;
  voice: string;
  /** Stable per drawing: profiles sharing a file share an id. */
  avatar_id?: string;
}

/** One remembered fact, as the robot stores it. */
export interface MemoryFact {
  id: string;
  text: string;
  createdAt: number;
}

/** The fields of `conversation.status` the phone reads (it carries more). */
export interface ConvAppStatus {
  /** False until the app's own voice backend is up: the real readiness. */
  backend_connected: boolean;
  /** Why the backend is not connected, when it is not. */
  backend_error: string | null;
  /** False when the robot itself is not signed in to Hugging Face. */
  has_hf_connection: boolean;
  /** Canonical name of the active profile, `null` for the robot's default. */
  personality: string | null;
  /** Speech transcription language, e.g. `en`. */
  language: string;
  /** Whether remembered facts reach the model. */
  memory_enabled: boolean;
  /** Whether the camera tool will answer. */
  vision_enabled: boolean;
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

  // Settings the phone owns and pushes at conversation start.
  getPersonalities(): Promise<RobotPersonality[]>;
  /** The profile's avatar as SVG markup. */
  getAvatar(name: string): Promise<string>;
  applyPersonality(name: string): Promise<void>;
  savePersonality(personality: RobotPersonality): Promise<void>;
  deletePersonality(name: string): Promise<void>;
  setLanguage(language: string): Promise<string>;
  setMemoryEnabled(enabled: boolean): Promise<boolean>;
  setVisionEnabled(enabled: boolean): Promise<boolean>;
  listMemory(): Promise<MemoryFact[]>;
  clearMemory(): Promise<void>;

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

    async getPersonalities() {
      return (await robot.rpcCall<{ personalities: RobotPersonality[] }>('personalities.all'))
        .personalities;
    },
    async getAvatar(name) {
      return (await robot.rpcCall<{ svg: string }>('personalities.avatar', { name })).svg;
    },
    async applyPersonality(name) {
      await robot.rpcCall('personalities.apply', { name, persist: true });
    },
    async savePersonality({ name, instructions, greeting, voice }) {
      // `personalities.save` names a profile by its bare slug and puts it in
      // the user namespace itself, unlike `apply` and `delete` which take the
      // namespaced name `personalities.all` reports.
      // `overwrite` covers the edit case; a create on a free name is the
      // same call, so the phone does not have to know which one it is.
      await robot.rpcCall('personalities.save', {
        name: name.startsWith(USER_PREFIX) ? name.slice(USER_PREFIX.length) : name,
        instructions,
        greeting,
        voice,
        overwrite: true,
      });
    },
    async deletePersonality(name) {
      await robot.rpcCall('personalities.delete', { name });
    },
    async setLanguage(language) {
      return (await robot.rpcCall<{ language: string }>('language.set', { language })).language;
    },
    async setMemoryEnabled(enabled) {
      return (await robot.rpcCall<{ enabled: boolean }>('memory.set_enabled', { enabled })).enabled;
    },
    async setVisionEnabled(enabled) {
      return (await robot.rpcCall<{ enabled: boolean }>('vision.set', { enabled })).enabled;
    },
    async listMemory() {
      return (await robot.rpcCall<{ facts: MemoryFact[] }>('memory.list')).facts;
    },
    async clearMemory() {
      await robot.rpcCall('memory.clear');
    },

    on(event, handler) {
      return robot.onNotification(event, handler);
    },
  };
}
