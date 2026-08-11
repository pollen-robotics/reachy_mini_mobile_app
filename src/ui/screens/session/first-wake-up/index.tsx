/**
 * First wake-up wizard (mobile).
 *
 * A short "let's make sure everything works" flow shown right after a
 * session goes `live`. It walks the user through the robot's senses and
 * actuators - microphone, motors, camera, speaker - over the live WebRTC
 * session, then lets them name the robot, and hands back to the normal
 * conversation UI. Step order: welcome, microphone, motor, camera, speaker,
 * name (see `STEPS` in `./constants`). The naming step is skipped when the
 * robot already carries a user-set name, so we never re-ask to rename it.
 *
 * Gating: shown only once per robot. `RobotSessionScreen` reads the robot's
 * persisted `get_first_wake_up` flag when the session goes live and mounts
 * this only when it's not completed yet; `onFinish` persists the flag via
 * `set_first_wake_up`. In dev, `FORCE_FIRST_WAKE_UP_IN_DEV` bypasses the flag
 * so the flow runs on every connection while iterating.
 *
 * Presentation mirrors `SetupWizardScreen`: a top progress bar, a
 * back/skip header, and one cross-fading step per page. This file is the
 * shell + step router; each step lives in `./steps/*` and exercises the
 * hardware through the `RobotSessionHandle` (mic AnalyserNode off
 * `getRobot()._pc`, `wakeUp()`, volume + `playSound`, `attachVideo`).
 */

import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, Stack, Typography, alpha, useTheme } from '@mui/material';
import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';
import { FONT_WEIGHT, LAYOUT, TYPO } from '@/ui/design/tokens';
import ReachyViz from '@/ui/widgets/reachy-viz/ReachyViz';
import FinishConfetti from './FinishConfetti';
import WakeUpIntro from './WakeUpIntro';
import { useRobotPose, useStaticPose } from '@/ui/widgets/reachy-viz/useRobotPose';
import { useSleepPositionCheck, type SleepPositionCheck } from '@/ui/widgets/reachy-viz/useSleepPositionCheck';
import { SLEEP_POSE } from '@/ui/widgets/reachy-viz/poses';
import { FINISH_MOVE, FINISH_MOVE_MS, STEPS, type Step } from './constants';
import { RESET_AFTER_MOVE_MS, resetToDefaultPose } from './motion';
import { useStepEmotes } from './useStepEmotes';
import { COLUMN_PX, SCAFFOLD_MIN_HEIGHT, STAGE_HEIGHT, STAGE_MAX_WIDTH } from './shared';
import WelcomeStep from './steps/WelcomeStep';
import MicrophoneStep from './steps/MicrophoneStep';
import MotorStep from './steps/MotorStep';
import SpeakerStep from './steps/SpeakerStep';
import CameraStep from './steps/CameraStep';
import NameStep from './steps/NameStep';

// Welcome-step layout: how far apart (scene units) the live robot and its
// target ghost sit while unaligned, and the ghost's fill opacity before it
// fades out on match.
const GHOST_SPLIT_OFFSET = 0.11;
// Re-orient the robot(s) to a 3/4 view (radians) so a bit of the back reads,
// without moving the (front-on, symmetric) camera. Applies to every wake-up
// step via the shared viz.
const WAKE_UP_YAW = Math.PI / 6;

// Closing sequence timing. `FINISH_MOVE` (welcoming2) is fired the instant the
// last step is confirmed. The robot is then sent back to its neutral
// (end-of-wake-up) pose - but only AFTER the move fully ends: while a recorded
// move is playing the daemon drives the motors itself and drops/overrides
// pose commands, so resetting mid-move did nothing. We wait a small buffer past
// the move's end, then keep the step UI faded out for RESET_SETTLE_MS so the
// robot reaches the standard pose in place before we hand off.
// `RESET_AFTER_MOVE_MS` + `resetToDefaultPose` now live in `./motion` so every
// step's emotion can share the same return-to-base behaviour.
const RESET_SETTLE_MS = 1000;
const FINISH_CELEBRATION_MS = FINISH_MOVE_MS + RESET_AFTER_MOVE_MS + RESET_SETTLE_MS;

// Let the closing greeting breathe before the confetti bursts: the step UI
// takes ~0.4 s to fade out and the "all set" line rises in just after, so
// popping the confetti on the very frame `finishing` flips reads as abrupt.
// Holding it back a beat makes the pop punctuate the robot's move instead.
const CONFETTI_DELAY_MS = 2600;

interface FirstWakeUpWizardProps {
  /** Live session handle (hardware access + SDK pass-throughs). */
  session: RobotSessionHandle;
  /** Friendly robot name for the copy. Updated live once the naming step saves,
   *  so the closing "meet" line reflects the chosen name. */
  robotName?: string;
  /** Persist a new display name over the session (naming step). Resolves the
   *  saved name, or `null` on failure. Updating the parent's optimistic name is
   *  the caller's job (so `robotName` here reflects it for the finale). */
  onRename: (name: string) => Promise<string | null>;
  /** Wizard cleared - hand back to the normal session UI. */
  onFinish: () => void;
}

export default function FirstWakeUpWizard({ session, robotName, onRename, onFinish }: FirstWakeUpWizardProps) {
  const [step, setStep] = useState<Step>('welcome');
  // Draft for the naming step, lifted here so it survives the step's remount on
  // step transitions (each step is keyed in AnimatePresence, so a local field
  // would reset). See `NameStep`.
  const [nameDraft, setNameDraft] = useState('');
  // Speaker volume, PREFETCHED here on mount (not on the speaker step's own
  // mount) so that by the time the user reaches "Hear My Voice" - four steps in
  // - the slider is already at the real value instead of showing a default then
  // jumping once the async read lands. `null` only during the initial fetch.
  const [speakerVolume, setSpeakerVolume] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    void session.getSpeakerVolume().then(v => {
      if (cancelled) return;
      setSpeakerVolume(typeof v === 'number' ? v : 50);
    });
    return () => {
      cancelled = true;
    };
  }, [session]);
  // While true, the closing finale is on screen (last step confirmed): the step
  // UI fades out and the robot plays the closing move in place. A timer then
  // hands back to the conversation UI.
  const [finishing, setFinishing] = useState(false);
  // Confetti is held back a beat after `finishing` (see CONFETTI_DELAY_MS) so
  // the burst punctuates the greeting rather than firing on the same frame.
  const [confettiOn, setConfettiOn] = useState(false);
  // The persistent 3D stage is visible for every step except when a step opens
  // its troubleshooting view (which replaces the whole column). Reset to true on
  // each step change; steps flip it off/on via `onStageVisible`.
  const [stageVisible, setStageVisible] = useState(true);
  // Skip the naming step when the robot already carries a user-set name.
  // `getRobotName()` returns the PERSISTED name (a deliberate rename), or null
  // when the robot still runs on the daemon's default (base) name - so a
  // non-empty answer means "already named, don't ask again". Fetched on mount;
  // it resolves long before the user reaches the end (naming is the last step),
  // and defaults to keeping the step on a slow/failed/unsupported read.
  const [hasCustomName, setHasCustomName] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve(session.getRobot()?.getRobotName() ?? null).then(name => {
      if (cancelled) return;
      setHasCustomName(typeof name === 'string' && name.trim().length > 0);
    });
    return () => {
      cancelled = true;
    };
  }, [session]);
  // Effective step list: drop `name` once we know the robot is already named,
  // so both the router and the progress bar treat the prior step as the last.
  const steps = useMemo<readonly Step[]>(
    () => (hasCustomName ? STEPS.filter(s => s !== 'name') : STEPS),
    [hasCustomName],
  );
  const index = steps.indexOf(step);
  const fraction = index / (steps.length - 1);

  const theme = useTheme();

  // One live pose subscription for the whole wizard, feeding the single
  // persistent viz. Steps don't own their own viz, so the canvas/model never
  // reload between steps.
  const livePoseRef = useRobotPose(session);

  // Sleep-pose target for the "Tuck Me In" (welcome) step: rendered as a
  // translucent ghost silhouette in the shared viz, and compared motor-by-motor
  // against the live pose. Lives in the shell (not the step) because the ghost
  // must share the persistent canvas with the live robot. The tint goes green
  // the instant the robot is in position. Cheap to keep mounted; only wired
  // into the viz while on the welcome step.
  const sleepPoseRef = useStaticPose(SLEEP_POSE);
  const sleepCheck = useSleepPositionCheck(session);
  const sleepBlocked = sleepCheck.hasData && !sleepCheck.inPosition;

  // Ghost/live layout for the welcome step. Until the robot matches the target,
  // the live robot slides left and the ghost sits right (side-by-side = far
  // more readable than overlapping). Once matched, the live robot recentres and
  // the ghost fades out (opacity 0), and its tint goes orange -> green.
  const onWelcome = step === 'welcome';
  const matched = sleepCheck.inPosition;
  const ghostColor = matched ? theme.palette.success.main : theme.palette.primary.main;
  const liveOffsetX = onWelcome && !matched ? -GHOST_SPLIT_OFFSET : 0;
  // Dissolve the ghost away (shader discard) once the pose matches.
  const ghostDissolve = matched ? 1 : 0;

  // Hold the whole wizard behind the animated wake-up intro until the
  // persistent viz has loaded and settled, so the first step appears in one go
  // rather than popping in before/around the 3D model. The extra delay past
  // viz-ready also gives the intro copy ("I'm not quite awake yet…") time to be
  // read, so it reads as an intentional beat rather than a flash.
  const [stepReady, setStepReady] = useState(false);
  const revealTimer = useRef<number | null>(null);
  const onVizReady = useCallback(() => {
    if (revealTimer.current !== null) return;
    revealTimer.current = window.setTimeout(() => setStepReady(true), 2400);
  }, []);
  // Safety net: never trap the user on the intro if the viz never signals
  // ready (e.g. the model fails to load or no pose ever streams).
  useEffect(() => {
    const t = window.setTimeout(() => setStepReady(true), 7000);
    return () => window.clearTimeout(t);
  }, []);
  useEffect(
    () => () => {
      if (revealTimer.current !== null) window.clearTimeout(revealTimer.current);
    },
    [],
  );

  useEffect(() => {
    setStageVisible(true);
  }, [step]);

  // The bring-up wake was deferred to this wizard: the motor step plays
  // the very first wake-up. Track it so we don't replay the move on
  // finish (the robot is already awake by then). Only if the user skips
  // BEFORE the motor step do we wake on the way out, so the conversation
  // UI always starts from an awake robot.
  const wokenRef = useRef(false);
  const markWoken = useCallback(() => {
    wokenRef.current = true;
  }, []);

  // Latest "is the robot in its sleep pose?" verdict, mirrored into a ref so the
  // emote controller can read it at play time without re-creating its callbacks
  // on every pose frame. Drives the wake move's ease-in (see `useStepEmotes`).
  const inSleepPoseRef = useRef(false);
  inSleepPoseRef.current = sleepCheck.hasData && sleepCheck.inPosition;
  const isInSleepPose = useCallback(() => inSleepPoseRef.current, []);

  // Shell-owned emote controller: each step's entry emote is fired here as a
  // navigation EVENT (see `goNext`), never from a step's mount
  // effect - so StrictMode can't double-fire it and no lifecycle race can start
  // two overlapping moves. Steps render off `playingStep` / `playedStep`.
  const { playingStep, playedStep, play: playStepEmote } = useStepEmotes(
    session,
    markWoken,
    isInSleepPose,
  );

  // A blocking emote is playing => lock the Skip header action so the user
  // can't bail mid-move. Only motor/camera/speaker set a playing step, so this
  // clears automatically on every other step.
  const navLocked = playingStep !== null;

  const handleFinish = useCallback(() => {
    if (!wokenRef.current) {
      // Best-effort: a slow ack must never trap the user on the wizard.
      void session.getRobot()?.wakeUp({ timeoutMs: 6000 }).catch(() => {});
    }
    onFinish();
  }, [session, onFinish]);

  // Confirming the last step plays the closing emotion IN PLACE: the live 3D viz
  // stays on screen, the step UI fades away, and the robot is dressed (a light
  // halo + a revealed "all set" line). The robot performing `FINISH_MOVE` is the
  // reward; the ambience only frames it. A timer hands back to the conversation
  // after the move + reset settle. "Skip" bypasses this via handleFinish.
  //
  // We mark the robot woken here: on the completion path it's already awake
  // (the motor step enabled it) and `FINISH_MOVE` is the closing "congrats"
  // animation, so `handleFinish` must NOT also fire the daemon's wake-up emote
  // (`wake_up.wav` + trajectory) - that's the "reachy connects" animation from
  // the no-wizard path and would double up with the celebration.
  const resetTimer = useRef<number | null>(null);
  const finishTimer = useRef<number | null>(null);
  // Cancels the pending neutral-pose retries (see `resetToDefaultPose`), so
  // none bleed into the conversation UI after handoff.
  const cancelResetRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      if (finishTimer.current !== null) window.clearTimeout(finishTimer.current);
      cancelResetRef.current?.();
    },
    [],
  );

  // Hold the confetti back a beat once the finale starts (and drop it again if
  // we somehow leave the finishing state), so the burst lands after the step UI
  // has cleared and the "all set" line has risen in.
  useEffect(() => {
    if (!finishing) {
      setConfettiOn(false);
      return;
    }
    const t = window.setTimeout(() => setConfettiOn(true), CONFETTI_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [finishing]);

  const finishWithCelebration = useCallback(() => {
    wokenRef.current = true;
    // Fire the closing greeting immediately, then reset to the neutral pose
    // once the move has finished (see RESET_AFTER_MOVE_MS - resetting mid-move
    // is a no-op). The robot stays on screen throughout, so the reset reads as
    // a smooth settle into the neutral pose rather than happening under cover.
    session.getRobot()?.playRecordedMove(FINISH_MOVE);
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => {
      cancelResetRef.current = resetToDefaultPose(session);
    }, FINISH_MOVE_MS + RESET_AFTER_MOVE_MS);
    // Hand back once the move + settle have played out, via an explicit timer
    // (the staging keeps the live viz, there's no overlay with an onDone).
    if (finishTimer.current !== null) window.clearTimeout(finishTimer.current);
    finishTimer.current = window.setTimeout(handleFinish, FINISH_CELEBRATION_MS);
    setFinishing(true);
  }, [session, handleFinish]);

  const goNext = useCallback(() => {
    const i = steps.indexOf(step);
    if (i >= steps.length - 1) {
      finishWithCelebration();
      return;
    }
    const next = steps[i + 1];
    setStep(next);
    // Fire the next step's entry emote as part of the transition event (no-op
    // for steps without one). This is the whole point of the event-driven
    // wizard: the move is tied to the navigation, not to the step's mount.
    playStepEmote(next);
  }, [step, steps, finishWithCelebration, playStepEmote]);

  return (
    // motion.div root so the wizard plays an exit fade when it unmounts (on
    // finish/skip): the parent `AnimatePresence` (see RobotSessionScreen) keeps
    // it mounted through the fade, revealing the conversation UI already mounted
    // behind it instead of hard-cutting on the last frame.
    <Box
      component={motion.div}
      initial={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
      sx={{
        position: 'fixed',
        inset: 0,
        // Below the daemon update gate (1400) so a mandatory update wins,
        // above the connecting / leaving overlays (1300).
        zIndex: 1380,
        bgcolor: 'background.default',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Edge-to-edge progress bar, flush to the top. */}
      <Box sx={{ height: 3, width: '100%', bgcolor: theme => alpha(theme.palette.text.primary, 0.08) }}>
        <Box
          sx={{
            height: '100%',
            width: `${fraction * 100}%`,
            bgcolor: 'primary.main',
            transition: 'width 400ms cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        />
      </Box>

      {/* Top bar: just the Skip action, pinned right (there's no Back - the
          wizard is forward-only). Fades away during the closing staging so
          only the robot + its line remain on screen. */}
      <Stack
        direction="row"
        sx={{
          alignItems: 'center',
          justifyContent: 'flex-end',
          pt: `calc(${LAYOUT.safeAreaTop} + 12px)`,
          pb: 1,
          px: 1,
          minHeight: 48,
          opacity: finishing ? 0 : 1,
          pointerEvents: finishing ? 'none' : 'auto',
          transition: 'opacity 0.4s ease',
        }}
      >
        <Button
          variant="text"
          onClick={handleFinish}
          disabled={navLocked}
          sx={{
            color: 'primary.main',
            textTransform: 'none',
            fontWeight: FONT_WEIGHT.semibold,
            fontSize: TYPO.sm,
            borderRadius: 999,
          }}
        >
          Skip
        </Button>
      </Stack>

      {/* Step content column: a fixed, full-height frame so every step shares
          the same skeleton (top-anchored 3D stage, bottom-anchored actions).
          Only the reserved middle zones vary, so nothing jumps between steps or
          between a step's internal states. */}
      <Box sx={{ flex: 1, minHeight: 0, width: '100%', display: 'flex', justifyContent: 'center', overflowY: 'auto' }}>
        <Box
          sx={{
            width: '100%',
            maxWidth: STAGE_MAX_WIDTH,
            px: COLUMN_PX,
            py: 3,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Relative anchor that fills the column. The persistent viz is pinned
              to its top stage region; each step is absolutely stacked over it so
              its <StageSlot> lines up exactly with the viz behind. */}
          <Box sx={{ position: 'relative', flex: 1, minHeight: SCAFFOLD_MIN_HEIGHT, width: '100%' }}>
            {/* Persistent viz: mounted once, pinned to the top region, behind
                every step. Hidden (but kept mounted) during troubleshooting. */}
            <Box
              aria-hidden
              sx={{
                position: 'absolute',
                top: 0,
                // Full-bleed: cancel the column padding so the canvas reaches
                // the screen edges. Must match StageSlot's break-out exactly so
                // step overlays stay aligned with the robot behind them.
                left: theme => theme.spacing(-COLUMN_PX),
                right: theme => theme.spacing(-COLUMN_PX),
                height: STAGE_HEIGHT,
                zIndex: 0,
                pointerEvents: 'none',
                opacity: stageVisible ? 1 : 0,
                transition: 'opacity 0.2s ease',
              }}
            >
              {/* Front-on camera (x=0) so the welcome step's live/ghost split
                  reads as a clean, symmetric left/right. The robot is angled to
                  3/4 via `yawOffset` on the welcome step, then eases to face the
                  user (yaw 0) once past it. Pulled back so raised antennas
                  never clip the taller canvas. */}
              <ReachyViz
                poseRef={livePoseRef}
                height={STAGE_HEIGHT}
                onReady={onVizReady}
                cameraPosition={[0, 0.4, 0.65]}
                yawOffset={onWelcome ? WAKE_UP_YAW : 0}
                offsetX={liveOffsetX}
                ghostPoseRef={onWelcome ? sleepPoseRef : undefined}
                ghostColor={ghostColor}
                ghostDissolve={ghostDissolve}
                ghostOffsetX={GHOST_SPLIT_OFFSET}
              />
            </Box>

            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={step}
                initial={{ opacity: 0 }}
                // Fade the step UI away during the closing staging, leaving the
                // robot alone on screen.
                animate={{ opacity: finishing ? 0 : 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: finishing ? 0.4 : 0.24, ease: [0.4, 0, 0.2, 1] }}
                style={{
                  position: 'absolute',
                  inset: 0,
                  zIndex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  pointerEvents: finishing ? 'none' : undefined,
                }}
              >
                <StepView
                  step={step}
                  session={session}
                  onNext={goNext}
                  onStageVisible={setStageVisible}
                  playing={playingStep === step}
                  played={playedStep === step}
                  onReplay={() => playStepEmote(step)}
                  sleepCheck={sleepCheck}
                  sleepBlocked={sleepBlocked}
                  onRename={onRename}
                  nameDraft={nameDraft}
                  onNameDraftChange={setNameDraft}
                  speakerVolume={speakerVolume}
                  onSpeakerVolumeChange={setSpeakerVolume}
                />
              </motion.div>
            </AnimatePresence>

            {/* Closing line, revealed under the robot once the step UI has
                faded. Sits just below the stage region so it reads as a caption
                to the robot's greeting. */}
            {finishing ? (
              <Box
                sx={{
                  position: 'absolute',
                  top: STAGE_HEIGHT,
                  left: 0,
                  right: 0,
                  zIndex: 2,
                  pt: 4,
                  px: 2,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  pointerEvents: 'none',
                }}
              >
                {/* Same fade + rise-in as the tutorial hints (see e.g. the mic
                    step): initial y:8, snappy 0.32 s ease. The two lines are
                    staggered and land just before the confetti pops. */}
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.32, ease: [0.4, 0, 0.2, 1], delay: 0.35 }}
                >
                  {robotName ? (
                    <>
                      <Typography
                        component="h1"
                        sx={{
                          fontSize: TYPO.hero,
                          fontWeight: FONT_WEIGHT.semibold,
                          letterSpacing: '-0.3px',
                          textAlign: 'center',
                          lineHeight: 1.2,
                          m: 0,
                        }}
                      >
                        Nice to meet you
                      </Typography>
                      {/* The name gets its own line, a notch larger, so it reads
                          as the headline of the greeting rather than a suffix. */}
                      <Typography
                        sx={{
                          fontSize: TYPO.display,
                          fontWeight: FONT_WEIGHT.bold,
                          letterSpacing: '-0.3px',
                          textAlign: 'center',
                          lineHeight: 1.2,
                          mt: 0.25,
                        }}
                      >
                        {robotName}
                      </Typography>
                    </>
                  ) : (
                    <Typography
                      component="h1"
                      sx={{
                        fontSize: TYPO.hero,
                        fontWeight: FONT_WEIGHT.bold,
                        letterSpacing: '-0.3px',
                        textAlign: 'center',
                        m: 0,
                      }}
                    >
                      All set
                    </Typography>
                  )}
                </motion.div>
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.32, ease: [0.4, 0, 0.2, 1], delay: 0.5 }}
                >
                  <Typography sx={{ mt: 0.5, fontSize: TYPO.md, color: 'text.secondary', textAlign: 'center' }}>
                    Let&apos;s chat
                  </Typography>
                </motion.div>
              </Box>
            ) : null}
          </Box>
        </Box>
      </Box>

      {/* Full-view intro gate: covers everything (incl. the top bar) until the
          persistent viz is ready, so the first step reveals all at once. Instead
          of a bare spinner it plays the animated "still asleep" intro, then
          cross-fades away to reveal the first step behind it. */}
      <AnimatePresence>
        {!stepReady ? (
          <motion.div
            key="wake-up-intro"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 10,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: theme.palette.background.default,
            }}
          >
            <WakeUpIntro />
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Closing confetti burst (R3F), rendered BEHIND the robot (see the
          component's zIndex). Held back a beat after `finishing` (see
          CONFETTI_DELAY_MS) and mounted only for the finale so it costs nothing
          otherwise. */}
      {confettiOn ? <FinishConfetti /> : null}
    </Box>
  );
}

function StepView({
  step,
  session,
  onNext,
  onStageVisible,
  playing,
  played,
  onReplay,
  sleepCheck,
  sleepBlocked,
  onRename,
  nameDraft,
  onNameDraftChange,
  speakerVolume,
  onSpeakerVolumeChange,
}: {
  step: Step;
  session: RobotSessionHandle;
  onNext: () => void;
  /** Steps call this to hide/show the shared persistent viz (e.g. hide it while
   *  a troubleshooting view owns the whole column). Reset to visible by the
   *  shell on every step change. */
  onStageVisible: (visible: boolean) => void;
  /** True while THIS step's entry emote (fired by the shell) is playing. */
  playing: boolean;
  /** True once THIS step's entry emote has finished (reveal confirm controls). */
  played: boolean;
  /** Replay THIS step's entry emote (manual "play again"). */
  onReplay: () => void;
  /** Sleep-pose comparison (owned by the shell, drives the welcome ghost). */
  sleepCheck: SleepPositionCheck;
  /** True when the robot isn't yet in sleep position (welcome step gate). */
  sleepBlocked: boolean;
  /** Persist a new display name over the session (naming step). */
  onRename: (name: string) => Promise<string | null>;
  /** Controlled naming-step draft (lifted to the shell to survive remounts). */
  nameDraft: string;
  onNameDraftChange: (name: string) => void;
  /** Prefetched speaker volume (0-100), or `null` while the initial read is in
   *  flight, so the speaker step's slider starts at the right value. */
  speakerVolume: number | null;
  onSpeakerVolumeChange: (v: number) => void;
}) {
  switch (step) {
    case 'welcome':
      return <WelcomeStep session={session} onNext={onNext} check={sleepCheck} blocked={sleepBlocked} />;
    case 'microphone':
      return <MicrophoneStep session={session} onNext={onNext} onStageVisible={onStageVisible} />;
    case 'motor':
      return (
        <MotorStep
          onNext={onNext}
          onStageVisible={onStageVisible}
          playing={playing}
          played={played}
          onReplay={onReplay}
        />
      );
    case 'speaker':
      return (
        <SpeakerStep
          session={session}
          onNext={onNext}
          onStageVisible={onStageVisible}
          playing={playing}
          played={played}
          onReplay={onReplay}
          volume={speakerVolume}
          onVolumeChange={onSpeakerVolumeChange}
        />
      );
    case 'camera':
      return (
        <CameraStep session={session} onNext={onNext} onStageVisible={onStageVisible} playing={playing} />
      );
    case 'name':
      return (
        <NameStep value={nameDraft} onChange={onNameDraftChange} onRename={onRename} onNext={onNext} />
      );
    default:
      return null;
  }
}
