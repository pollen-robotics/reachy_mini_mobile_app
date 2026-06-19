/**
 * First wake-up wizard (mobile).
 *
 * A short "let's make sure everything works" flow shown right after a
 * session goes `live`. It walks the user through the robot's senses and
 * actuators - microphone, motors, speaker, camera - using the live
 * WebRTC session, then hands back to the normal conversation UI.
 *
 * TEMPORARY behaviour: this gate currently triggers on EVERY connection
 * (no persistence). Once the daemon/SDK `get/set_first_wake_up` flag
 * lands (see `docs/FIRST_WAKE_UP_WIZARD_PLAN.md`), the mount condition in
 * `RobotSessionScreen` will gate this on "not completed yet" instead.
 *
 * Presentation mirrors `SetupWizardScreen`: a top progress bar, a
 * back/skip header, and one cross-fading step per page. This file is the
 * shell + step router; each step lives in `./steps/*` and exercises the
 * hardware through the `RobotSessionHandle` (mic AnalyserNode off
 * `getRobot()._pc`, `wakeUp()`, volume + `playSound`, `attachVideo`).
 */

import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useRef, useState } from 'react';
import { Box, Button, Stack, alpha } from '@mui/material';
import ArrowBackIosNewIcon from '@mui/icons-material/ArrowBackIosNew';

import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';
import { FONT_WEIGHT, LAYOUT, TYPO } from '@/ui/design/tokens';
import { STEPS, type Step } from './constants';
import WelcomeStep from './steps/WelcomeStep';
import MicrophoneStep from './steps/MicrophoneStep';
import MotorStep from './steps/MotorStep';
import SpeakerStep from './steps/SpeakerStep';
import CameraStep from './steps/CameraStep';
import SuccessStep from './steps/SuccessStep';

interface FirstWakeUpWizardProps {
  /** Live session handle (hardware access + SDK pass-throughs). */
  session: RobotSessionHandle;
  /** Friendly robot name for the copy. */
  robotName?: string;
  /** Wizard cleared - hand back to the normal session UI. */
  onFinish: () => void;
}

export default function FirstWakeUpWizard({ session, robotName, onFinish }: FirstWakeUpWizardProps) {
  const [step, setStep] = useState<Step>('welcome');
  const index = STEPS.indexOf(step);
  const fraction = index / (STEPS.length - 1);

  // The bring-up wake was deferred to this wizard: the motor step plays
  // the very first wake-up. Track it so we don't replay the move on
  // finish (the robot is already awake by then). Only if the user skips
  // BEFORE the motor step do we wake on the way out, so the conversation
  // UI always starts from an awake robot.
  const wokenRef = useRef(false);

  const handleFinish = useCallback(() => {
    if (!wokenRef.current) {
      // Best-effort: a slow ack must never trap the user on the wizard.
      void session.getRobot()?.wakeUp({ timeoutMs: 6000 }).catch(() => {});
    }
    onFinish();
  }, [session, onFinish]);

  const goNext = useCallback(() => {
    setStep(prev => {
      const i = STEPS.indexOf(prev);
      return STEPS[Math.min(i + 1, STEPS.length - 1)];
    });
  }, []);

  const goBack = useCallback(() => {
    setStep(prev => {
      const i = STEPS.indexOf(prev);
      return STEPS[Math.max(i - 1, 0)];
    });
  }, []);

  const canGoBack = index > 0 && step !== 'success';

  return (
    <Box
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

      {/* Top bar: back on the left, skip on the right (skip hidden on success). */}
      <Stack
        direction="row"
        sx={{
          alignItems: 'center',
          justifyContent: 'space-between',
          pt: `calc(${LAYOUT.safeAreaTop} + 12px)`,
          pb: 1,
          px: 1,
          minHeight: 48,
        }}
      >
        {canGoBack ? (
          <Button
            aria-label="Previous step"
            onClick={goBack}
            startIcon={<ArrowBackIosNewIcon sx={{ fontSize: 16 }} />}
            sx={{
              color: 'primary.main',
              textTransform: 'none',
              fontWeight: FONT_WEIGHT.semibold,
              fontSize: TYPO.sm,
              borderRadius: 999,
            }}
          >
            Back
          </Button>
        ) : (
          <Box />
        )}
        {step !== 'success' ? (
          <Button
            onClick={handleFinish}
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
        ) : (
          <Box />
        )}
      </Stack>

      {/* Step content column. */}
      <Stack sx={{ flex: 1, minHeight: 0, width: '100%', overflowY: 'auto' }}>
        <Stack
          sx={{
            m: 'auto',
            width: '100%',
            maxWidth: LAYOUT.contentMaxWidth,
            px: 3,
            py: 3,
            alignItems: 'center',
          }}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={step}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.26, ease: [0.4, 0, 0.2, 1] }}
              style={{ width: '100%' }}
            >
              <StepView
                step={step}
                session={session}
                robotName={robotName}
                onNext={goNext}
                onFinish={handleFinish}
                onWoke={() => {
                  wokenRef.current = true;
                }}
              />
            </motion.div>
          </AnimatePresence>
        </Stack>
      </Stack>
    </Box>
  );
}

function StepView({
  step,
  session,
  robotName,
  onNext,
  onFinish,
  onWoke,
}: {
  step: Step;
  session: RobotSessionHandle;
  robotName?: string;
  onNext: () => void;
  onFinish: () => void;
  /** The motor step calls this once it has woken the robot, so the
   *  wizard knows the wake already happened and skips it on finish. */
  onWoke: () => void;
}) {
  switch (step) {
    case 'welcome':
      return <WelcomeStep robotName={robotName} onNext={onNext} />;
    case 'microphone':
      return <MicrophoneStep session={session} onNext={onNext} />;
    case 'motor':
      return <MotorStep session={session} onNext={onNext} onWoke={onWoke} />;
    case 'speaker':
      return <SpeakerStep session={session} onNext={onNext} />;
    case 'camera':
      return <CameraStep session={session} onNext={onNext} />;
    case 'success':
      return <SuccessStep robotName={robotName} onFinish={onFinish} />;
    default:
      return null;
  }
}
