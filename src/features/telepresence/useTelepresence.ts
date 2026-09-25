/**
 * React glue for the telepresence tab: owns the motion controller and
 * the two audio legs for as long as `active` is true.
 *
 * `active` = tab visible AND session live AND not in manual overboard
 * mode. Flipping it off parks the head/base/antennas back to neutral,
 * stops the phone mic (releasing the OS mic indicator) and drops the
 * robot audio element - so the conversation tab finds the robot and the
 * audio sender exactly as it left them.
 *
 * `allowMotion` is the host's veto (session tearing down, wake-up
 * trajectory or first-wake-up wizard in progress). Combined with the
 * robot's own motor state it gates EVERY motion frame, including the
 * park glide, so telepresence never fights a sleep / wake trajectory.
 *
 * Audio defaults on entry: robot → phone ON (you hear the room straight
 * away), phone → robot OFF (the first unmute is the user gesture that
 * lets iOS show the mic prompt).
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';

import {
  attachPhoneMic,
  createRobotAudioPlayer,
  type PhoneMicLink,
  type RobotAudioPlayer,
} from './audio-link';
import {
  TelepresenceMotionController,
  flatMatrixToRpy,
  type MotionSnapshot,
  type ReportedPose,
} from './motion-controller';
import type { TelepresenceEmotion } from './emotions';

/** Poll period while waiting for an emotion to finish. */
const EMOTION_POLL_MS = 150;
/** Give up waiting for `is_move_running` to clear this long after the nominal end. */
const EMOTION_GRACE_MS = 4000;

const POLL_MS = 1000;
const RAD_TO_DEG = 180 / Math.PI;

export interface UseTelepresenceOptions {
  getRobot: () => ReachyMiniInstance | null;
  active: boolean;
  /** Host veto on motion (leaving, waking, wizard). */
  allowMotion: boolean;
  /** Head joystick deflection getter (read every control tick). */
  getHeadDeflection: () => { x: number; y: number } | null;
}

export interface TelepresenceHandle {
  motion: MotionSnapshot;
  setRollTarget(deg: number): void;
  setBodyYawTarget(deg: number): void;
  setAntennasTarget(right: number, left: number): void;
  recenterHead(): void;
  resetPose(): void;
  /** Glide back to neutral and stop (before releasing the session). */
  park(): Promise<void>;

  /** Motors enabled (null = unknown yet). Motion is held while false. */
  robotAwake: boolean | null;
  wakeUp(): Promise<void>;
  wakingUp: boolean;

  /** Phone mic → robot speaker. */
  talkEnabled: boolean;
  /** Mic capture in flight (permission prompt, replaceTrack). */
  talkPending: boolean;
  /** Last mic capture failure, cleared on the next attempt. */
  talkError: string | null;
  setTalkEnabled(enabled: boolean): void;
  /** Robot mic → phone speaker. */
  listenEnabled: boolean;
  setListenEnabled(enabled: boolean): void;

  /** Play a recorded emotion; head control is handed to it until it ends. */
  playEmotion(emotion: TelepresenceEmotion): void;
  /** Id of the emotion playing, or null. */
  emotionPlaying: string | null;
}

function readRobotPose(robot: ReachyMiniInstance | null): ReportedPose | null {
  const state = robot?.robotState;
  if (!state) return null;
  const pose: ReportedPose = {};
  if (state.head?.length === 16) Object.assign(pose, flatMatrixToRpy(state.head));
  if (typeof state.body_yaw === 'number') pose.bodyYaw = state.body_yaw * RAD_TO_DEG;
  if (state.antennas?.length === 2) {
    pose.antennaRight = state.antennas[0] * RAD_TO_DEG;
    pose.antennaLeft = state.antennas[1] * RAD_TO_DEG;
  }
  return pose;
}

export function useTelepresence({
  getRobot,
  active,
  allowMotion,
  getHeadDeflection,
}: UseTelepresenceOptions): TelepresenceHandle {
  const getRobotRef = useRef(getRobot);
  getRobotRef.current = getRobot;
  const getDeflectionRef = useRef(getHeadDeflection);
  getDeflectionRef.current = getHeadDeflection;
  const allowMotionRef = useRef(allowMotion);
  allowMotionRef.current = allowMotion;
  // While an emotion plays the daemon's move player owns the head: the
  // controller stops sending and follows the reported pose instead.
  const emotionBusyRef = useRef(false);

  const [controller] = useState(
    () =>
      new TelepresenceMotionController({
        getSink: () => getRobotRef.current(),
        getDeflection: () => getDeflectionRef.current(),
        getRobotPose: () => readRobotPose(getRobotRef.current()),
        canMove: () =>
          allowMotionRef.current && !emotionBusyRef.current && getRobotRef.current()?.isAwake() === true,
      }),
  );
  const motion = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  // ─── Motion lifecycle ────────────────────────────────────────────
  useEffect(() => {
    if (!active) return;
    controller.start();
    return () => {
      // Immediate stop when motion is vetoed (e.g. tearing down): the
      // controller's canMove() gate makes park() a no-op in that case.
      void controller.park();
    };
  }, [active, controller]);

  // ─── Robot awake state (drives the "wake up" affordance) ─────────
  const [robotAwake, setRobotAwake] = useState<boolean | null>(null);
  const [wakingUp, setWakingUp] = useState(false);
  useEffect(() => {
    if (!active) return;
    const read = () => {
      const robot = getRobotRef.current();
      if (!robot || robot.robotState?.motor_mode === undefined) return setRobotAwake(null);
      setRobotAwake(robot.isAwake());
    };
    read();
    const poll = setInterval(read, POLL_MS);
    return () => clearInterval(poll);
  }, [active]);

  const wakeUp = useCallback(async () => {
    const robot = getRobotRef.current();
    if (!robot) return;
    setWakingUp(true);
    try {
      await robot.wakeUp({ timeoutMs: 8000 });
      setRobotAwake(robot.isAwake());
    } catch (err) {
      console.warn('[telepresence] wake-up failed:', err);
    } finally {
      setWakingUp(false);
    }
  }, []);

  // ─── Audio legs ──────────────────────────────────────────────────
  const [talkEnabled, setTalkState] = useState(false);
  const [talkPending, setTalkPending] = useState(false);
  const [talkError, setTalkError] = useState<string | null>(null);
  const [listenEnabled, setListenState] = useState(true);
  const micRef = useRef<PhoneMicLink | null>(null);
  const micPendingRef = useRef(false);
  /** Bumped on every audio teardown: late mic attaches from a previous
   *  activation must dispose themselves instead of landing on the sender. */
  const audioGenRef = useRef(0);
  const playerRef = useRef<RobotAudioPlayer | null>(null);
  const listenRef = useRef(listenEnabled);
  listenRef.current = listenEnabled;

  useEffect(() => {
    if (!active) return;
    const player = createRobotAudioPlayer();
    playerRef.current = player;
    void player.setMuted(!listenRef.current);
    const enforce = () => {
      const robot = getRobotRef.current();
      if (!robot) return;
      player.ensure(robot);
      void micRef.current?.ensure(robot);
    };
    enforce();
    const poll = setInterval(enforce, POLL_MS);
    return () => {
      audioGenRef.current += 1;
      clearInterval(poll);
      player.dispose();
      playerRef.current = null;
      const mic = micRef.current;
      micRef.current = null;
      void mic?.dispose();
      setTalkState(false);
    };
  }, [active]);

  const setListenEnabled = useCallback((enabled: boolean) => {
    setListenState(enabled);
    const player = playerRef.current;
    if (!player) return;
    void player.setMuted(!enabled).then((ok) => {
      if (!ok) setListenState(false);
    });
  }, []);

  const setTalkEnabled = useCallback((enabled: boolean) => {
    const mic = micRef.current;
    if (!enabled) {
      mic?.setMuted(true);
      setTalkState(false);
      return;
    }
    if (mic) {
      mic.setMuted(false);
      setTalkState(true);
      return;
    }
    const robot = getRobotRef.current();
    if (!robot || micPendingRef.current) return;
    micPendingRef.current = true;
    setTalkPending(true);
    setTalkError(null);
    const gen = audioGenRef.current;
    // Must stay synchronous up to getUserMedia: this runs inside the tap
    // handler, which is what lets iOS show the permission prompt.
    attachPhoneMic(robot)
      .then((link) => {
        if (gen !== audioGenRef.current) {
          // Tab left / manual mode entered while we were attaching.
          void link.dispose();
          return;
        }
        micRef.current = link;
        link.setMuted(false);
        setTalkState(true);
      })
      .catch((err: unknown) => {
        console.warn('[telepresence] phone mic capture failed:', err);
        setTalkError(err instanceof Error ? err.message : String(err));
        setTalkState(false);
      })
      .finally(() => {
        micPendingRef.current = false;
        setTalkPending(false);
      });
  }, []);

  // ─── Emotions ────────────────────────────────────────────────────
  const [emotionPlaying, setEmotionPlaying] = useState<string | null>(null);
  const emotionCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => emotionCleanupRef.current?.(), []);

  const playEmotion = useCallback((emotion: TelepresenceEmotion) => {
    const robot = getRobotRef.current();
    if (!robot || emotionBusyRef.current) return;
    if (!robot.playRecordedMove(emotion.move, { dataset: emotion.dataset })) return;
    emotionBusyRef.current = true;
    setEmotionPlaying(emotion.id);
    // The pose stream keeps `is_move_running` and the followed pose fresh.
    const subscribed = robot.subscribePose();
    const startedAt = Date.now();
    const nominalMs = emotion.durationS * 1000;
    const finish = () => {
      clearInterval(poll);
      if (subscribed) robot.unsubscribePose();
      emotionCleanupRef.current = null;
      emotionBusyRef.current = false;
      setEmotionPlaying(null);
    };
    const poll = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const running = (robot.robotState as { is_move_running?: boolean }).is_move_running === true;
      if ((elapsed > nominalMs && !running) || elapsed > nominalMs + EMOTION_GRACE_MS) finish();
    }, EMOTION_POLL_MS);
    emotionCleanupRef.current = finish;
  }, []);

  return {
    motion,
    setRollTarget: (deg) => controller.setRollTarget(deg),
    setBodyYawTarget: (deg) => controller.setBodyYawTarget(deg),
    setAntennasTarget: (r, l) => controller.setAntennasTarget(r, l),
    recenterHead: () => controller.recenterHead(),
    resetPose: () => controller.resetPose(),
    park: () => controller.park(),
    robotAwake,
    wakeUp,
    wakingUp,
    talkEnabled,
    talkPending,
    talkError,
    setTalkEnabled,
    listenEnabled,
    setListenEnabled,
    playEmotion,
    emotionPlaying,
  };
}
