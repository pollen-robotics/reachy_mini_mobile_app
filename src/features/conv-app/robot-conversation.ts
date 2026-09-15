/**
 * The conversation half of the engine, running ON THE ROBOT.
 *
 * The phone used to run the whole realtime pipeline itself: it pulled the
 * robot's mic over WebRTC, talked to Hugging Face, pushed the answer back
 * to the robot's speaker and animated the head. All of that now happens in
 * the conversation app on the robot; the phone starts that app through the
 * daemon, then observes it over JSON-RPC to drive the orb. Nothing here
 * touches audio or motion.
 *
 * What the robot tells us and what we make of it:
 *
 *   conversation.turn   listening | thinking | speaking | ready
 *                       → the orb's `ConversationState`. `ready` (the
 *                         model is between turns) reads as `listening`:
 *                         the robot is waiting for the user either way.
 *   conversation.level  { role: user|assistant, rms }, ~15 Hz per role
 *                       → the orb's CSS variables, and the `user-speaking`
 *                         state, which the robot never emits itself.
 *   conversation.activity { reason }
 *                       → a tool toast on `tool_call_received`.
 *
 * Readiness is `conversation.status.backend_connected`: `apps.status` says
 * `running` the moment the process forks, long before the app can talk.
 */
import { compareSemver, parseSemver } from '@/features/daemon-update/latestRelease';
import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';
import { rpcErrorReason } from '@/features/robot-session/sdk-types';
import type {
  ConversationLevelEvent,
  ConversationState,
  ConversationToolToastEvent,
} from '@/features/conversation/engine/types';

import {
  CONV_APP_NAME,
  createConvAppClient,
  type ConvAppClient,
  type ConvAppStatus,
} from './client';
import { setLiveRobot } from './live-client';
import { cacheFacts } from './memory-cache';
import { applySettingsToRobot } from './sync-settings';

/**
 * First daemon release that relays JSON-RPC over the WebRTC data channel
 * (reachy_mini#1266, landed in v1.10.0). Everything the phone does with the
 * conversation goes through that relay, so an older robot cannot host it at
 * all and the user is sent to the update gate instead of a timeout.
 */
const MIN_DAEMON_VERSION = '1.10.0';

/** How long the app may take from `apps.start` to a connected backend. */
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 1_000;
/** Mic RMS (0..1, robot-scaled) above which the user counts as speaking. */
const USER_SPEAKING_THRESHOLD = 0.15;
/** How long after the last loud frame the user still counts as speaking. */
const USER_SPEAKING_HOLD_MS = 400;
/** Per-frame decay of the peak-held levels, at ~60 Hz. */
const LEVEL_DECAY = 0.88;
/** Relative height of the five orb bars, so they don't read as one block. */
const BAR_PROFILE = [0.55, 0.8, 1, 0.8, 0.55] as const;

type RobotTurn = 'listening' | 'thinking' | 'speaking' | 'ready';

const TURN_TO_STATE: Record<RobotTurn, ConversationState> = {
  listening: 'listening',
  thinking: 'processing',
  speaking: 'ai-speaking',
  ready: 'listening',
};

export interface RobotConversationDeps {
  getRobot: () => ReachyMiniInstance | null;
  /** Daemon version read at bring-up, `null` when it never answered. */
  getDaemonVersion: () => string | null;
  isUnmounted: () => boolean;
  setConversationState: (state: ConversationState) => void;
  currentConversationState: () => ConversationState;
  emitErrorMessage: (message: string | null) => void;
  /** Where the orb's CSS variables land; re-read every frame. */
  getLevelsTarget: () => HTMLElement | null;
  onLevels: ((level: ConversationLevelEvent) => void) | null;
  onToolToast: ((toast: ConversationToolToastEvent) => void) | null;
}

export interface RobotConversation {
  /**
   * Bring the on-robot conversation up. Resolves `true` once the robot's
   * backend is connected and the orb is following it, `false` when it
   * could not start (the state is back on `idle` and the caption says why).
   */
  start(): Promise<boolean>;
  /** Stop the app on the robot and stop following it. Idempotent. */
  stop(): Promise<void>;
  setMicMuted(muted: boolean): void;
  /** Latest user level, 0..1, for rAF-driven visuals. */
  getMicLevel(): number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createRobotConversation(deps: RobotConversationDeps): RobotConversation {
  let client: ConvAppClient | null = null;
  let running = false;
  const unsubscribes: Array<() => void> = [];

  // Levels are peak-held here and decayed in the rAF loop, so a 15 Hz feed
  // still animates smoothly at 60 Hz.
  let userLevel = 0;
  let aiLevel = 0;
  let lastLoudAt = 0;
  let robotTurn: RobotTurn = 'ready';
  let raf = 0;

  const fail = (message: string): false => {
    deps.emitErrorMessage(message);
    deps.setConversationState('idle');
    return false;
  };

  // The robot sends one level per side, so the bars differ only by a fixed
  // profile. `bands` stays null: a synthesised spectrum would be invented data.
  const writeLevels = (): void => {
    const style = deps.getLevelsTarget()?.style;
    if (style) {
      style.setProperty('--audio-level', userLevel.toFixed(3));
      style.setProperty('--ai-audio-level', aiLevel.toFixed(3));
      for (let i = 0; i < 5; i++) {
        style.setProperty(`--bar${i}`, (userLevel * BAR_PROFILE[i]).toFixed(3));
      }
    }
    deps.onLevels?.({ user: userLevel, ai: aiLevel, bands: null });
  };

  // The robot has no `user-speaking` turn: it reports `listening` for the
  // whole user turn. Derive it from the mic level so the orb keeps its
  // current vocabulary, and only while the robot itself is listening.
  const updateUserSpeaking = (now: number): void => {
    if (robotTurn !== 'listening' && robotTurn !== 'ready') return;
    const state = deps.currentConversationState();
    if (userLevel > USER_SPEAKING_THRESHOLD) {
      lastLoudAt = now;
      if (state === 'listening') deps.setConversationState('user-speaking');
    } else if (state === 'user-speaking' && now - lastLoudAt > USER_SPEAKING_HOLD_MS) {
      deps.setConversationState('listening');
    }
  };

  const tick = (now: number): void => {
    if (!running) return;
    userLevel *= LEVEL_DECAY;
    aiLevel *= LEVEL_DECAY;
    writeLevels();
    updateUserSpeaking(now);
    raf = requestAnimationFrame(tick);
  };

  const onTurn = (params: Record<string, unknown>): void => {
    if (!running || deps.currentConversationState() === 'stopping') return;
    const turn = params.state;
    if (turn !== 'listening' && turn !== 'thinking' && turn !== 'speaking' && turn !== 'ready')
      return;
    robotTurn = turn;
    deps.setConversationState(TURN_TO_STATE[turn]);
  };

  const onLevel = (params: Record<string, unknown>): void => {
    const rms = typeof params.rms === 'number' ? Math.min(1, Math.max(0, params.rms)) : 0;
    if (params.role === 'assistant') aiLevel = Math.max(aiLevel, rms);
    else userLevel = Math.max(userLevel, rms);
  };

  const onActivity = (params: Record<string, unknown>): void => {
    if (params.reason === 'tool_call_received') {
      deps.onToolToast?.({ label: 'Using a tool…', durationMs: 4_000 });
    }
    // `remember` and `forget` are tools, and the robot has no memory-specific
    // event, so any finished tool call is the cue to re-read the list. It is
    // one small call, a few times per conversation.
    if (params.reason === 'tool_result_ready') void refreshMemory();
  };

  const refreshMemory = async (): Promise<void> => {
    const activeClient = client;
    if (!activeClient) return;
    try {
      cacheFacts(await activeClient.listMemory());
    } catch (err) {
      console.warn('[robot-conversation] could not re-read the robot memory:', err);
    }
  };

  const follow = (activeClient: ConvAppClient): void => {
    unsubscribes.push(
      activeClient.on('conversation.turn', onTurn),
      activeClient.on('conversation.level', onLevel),
      activeClient.on('conversation.activity', onActivity)
    );
    raf = requestAnimationFrame(tick);
  };

  const unfollow = (): void => {
    for (const off of unsubscribes.splice(0)) off();
    cancelAnimationFrame(raf);
    userLevel = 0;
    aiLevel = 0;
    writeLevels();
  };

  /**
   * Make sure the conversation app is the app holding the robot. Returns
   * the reason it cannot be, or null when it is running (or was just
   * started). Never takes the robot away from another app: that is an
   * explicit user action in the Apps tab, not a side effect of a tap.
   */
  /**
   * A daemon we could read and that predates the relay cannot host the
   * conversation. One we could not read is let through: the bring-up version
   * probe is best-effort, and failing there is not evidence of an old robot.
   */
  const daemonTooOld = (version: string | null): string | null => {
    const current = parseSemver(version);
    const min = parseSemver(MIN_DAEMON_VERSION);
    if (!current || !min || compareSemver(current, min) >= 0) return null;
    return `Reachy needs version v${MIN_DAEMON_VERSION} or newer to talk. Update it, then try again.`;
  };

  const ensureAppRunning = async (activeClient: ConvAppClient): Promise<string | null> => {
    const app = await activeClient.getCurrentAppStatus();
    if (app.state === 'running' || app.state === 'starting') {
      const name = app.info?.name ?? null;
      if (name === CONV_APP_NAME) return null;
      return `Reachy is busy with ${name ?? 'another app'}. Stop it from the Apps tab first.`;
    }
    try {
      await activeClient.startConvApp();
      return null;
    } catch (err) {
      const reason = rpcErrorReason(err);
      if (reason === 'already_running') return null;
      // A reasoned refusal we did not anticipate is most likely "not
      // installed" on a fresh robot. No reason at all is a transport
      // problem, and installing would not help.
      if (reason === undefined)
        return 'Lost the robot while starting the conversation. Retry in a moment.';
    }
    try {
      await activeClient.installConvApp();
      await activeClient.startConvApp();
      return null;
    } catch (err) {
      console.warn('[robot-conversation] install + start failed:', err);
      return 'Could not install the conversation app on Reachy. Check its connection and retry.';
    }
  };

  /**
   * Poll `conversation.status` until the backend is connected, then hand the
   * robot the settings the phone owns (see `sync-settings.ts`).
   */
  const waitUntilReady = async (activeClient: ConvAppClient): Promise<string | null> => {
    const deadline = performance.now() + READY_TIMEOUT_MS;
    let lastError: string | null = null;
    while (performance.now() < deadline) {
      if (!running) return 'Stopped before the conversation was ready.';
      let status: ConvAppStatus | null = null;
      try {
        status = await activeClient.getStatus();
      } catch (err) {
        // `not_running` / `app_unavailable` while the process boots is
        // expected; anything without a reason is the link, not the app.
        if (rpcErrorReason(err) === undefined)
          return 'Lost the robot while starting the conversation. Retry in a moment.';
      }
      if (status) {
        if (!status.has_hf_connection)
          return 'Sign your Reachy in to Hugging Face from the setup wizard to start talking.';
        if (status.backend_connected) {
          await applySettingsToRobot(activeClient, status);
          return null;
        }
        if (status.backend_error) lastError = status.backend_error;
      }
      await sleep(READY_POLL_MS);
    }
    return lastError
      ? `Reachy could not reach its voice backend: ${lastError}`
      : 'Reachy took too long to start the conversation. Retry in a moment.';
  };

  return {
    async start() {
      const robot = deps.getRobot();
      if (!robot || running) return false;
      const activeClient = createConvAppClient(robot);
      client = activeClient;
      running = true;
      deps.emitErrorMessage(null);
      deps.setConversationState('starting');

      const tooOld = daemonTooOld(deps.getDaemonVersion());
      if (tooOld) {
        running = false;
        return fail(tooOld);
      }
      const blocked = await ensureAppRunning(activeClient).catch((err: unknown) => {
        console.warn('[robot-conversation] apps.status failed:', err);
        return 'Could not reach Reachy. Retry in a moment.' as string;
      });
      const notReady = blocked ?? (await waitUntilReady(activeClient));
      if (deps.isUnmounted() || !running) {
        running = false;
        return false;
      }
      if (notReady) {
        running = false;
        return fail(notReady);
      }

      robotTurn = 'ready';
      setLiveRobot(robot);
      follow(activeClient);
      deps.setConversationState('listening');
      return true;
    },

    async stop() {
      if (!running && client === null) return;
      running = false;
      setLiveRobot(null);
      unfollow();
      const activeClient = client;
      client = null;
      if (!activeClient) return;
      try {
        await activeClient.stopRunningApp();
      } catch (err) {
        // `internal_error` here means nothing was running; either way the
        // robot is free, which is all the caller needs.
        console.debug('[robot-conversation] apps.stop:', err);
      }
    },

    setMicMuted(muted) {
      const activeClient = client;
      if (!activeClient || !running) return;
      activeClient.setMicMuted(muted).catch((err: unknown) => {
        console.warn('[robot-conversation] conversation.mic failed:', err);
      });
    },

    getMicLevel() {
      return userLevel;
    },
  };
}
