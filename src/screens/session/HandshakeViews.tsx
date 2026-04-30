/**
 * Handshake-phase views.
 *
 * The session screen renders one of these three cells while
 * `phase ∈ {'handshake', 'engine'}`:
 *
 *   HandshakeRunningView - default during bring-up, shows the
 *                          status orb, robot identity, and a
 *                          vertical step list with live details.
 *   HandshakeFailureView - replaces the running view as soon as
 *                          the FSM holds a non-null error. Reuses
 *                          the same composition (orb + identity +
 *                          step list) so the user keeps continuity;
 *                          the failed step turns red and a copy
 *                          block + actions appear underneath.
 *   HandshakeReadyView   - rendered by the conversation view as an
 *                          overlay during 'ready'. Lives here
 *                          because it's a sibling of the two above.
 *
 * None of these components are aware of the FSM. They take plain
 * strings + `() => void` callbacks; the parent does the bridging.
 *
 * Visual rationale
 * ────────────────
 * The previous design split the connect screen into two competing
 * focal points: a small horizontal stepper at the top, and a large
 * floating astronaut/rocket in the middle. On a 4-inch screen this
 * produced ambiguity ("am I supposed to read the top or the
 * middle?") and the alternating-label stepper became cramped as
 * soon as we tried to enrich its labels with observed values
 * (`Network · 192.168.1.42`).
 *
 * The new layout collapses everything into one centred column:
 *
 *           [ status orb ]
 *
 *           Reachy Mini
 *           via Wi-Fi · 192.168.1.42
 *
 *     ┌───────────────────────────┐
 *     │ ✓ Bluetooth               │
 *     │ ✓ Network                 │
 *     │   192.168.1.42            │
 *     │ ⟳ Daemon                  │
 *     │   v1.7.4                  │
 *     │ ○ Wake up                 │
 *     └───────────────────────────┘
 *
 * Each enrichment now has its own line, the icons carry the
 * progression signal, and the orb above mirrors the active step's
 * health (pulsing primary, or solid red on failure).
 */
import { useMemo } from 'react';

import {
  Box,
  Button,
  CircularProgress,
  Collapse,
  Stack,
  Typography,
} from '@mui/material';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import ErrorRoundedIcon from '@mui/icons-material/ErrorRounded';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import RadioButtonUncheckedRoundedIcon from '@mui/icons-material/RadioButtonUncheckedRounded';
import ReplayIcon from '@mui/icons-material/Replay';
import RocketLaunchRoundedIcon from '@mui/icons-material/RocketLaunchRounded';
import WifiIcon from '@mui/icons-material/Wifi';

import type { HandshakeError, SessionPhase } from '../../session/sessionFsm';
import { FONT_WEIGHT, RADIUS, STATUS, TYPO } from '../../styles/tokens';
import type { BleWifiProbe } from '../../types/robot';
import { describeProbeRefinement } from '../../wifi/describeProbe';

// ─── Status orb (handshake-only) ─────────────────────────────────────

/**
 * Compact status indicator rendered above the robot identity.
 * Deliberately *not* the conversation `ConversationOrb`: that one
 * couples to the audio engine and is much larger
 * (`clamp(220px, 38vw, 320px)`). For handshake we want a 96 px
 * disc that sits comfortably above the step list on a 4-inch
 * phone.
 *
 * Two states:
 *   - `active`: pulsing primary-coloured ring + spinner inside.
 *               Used during handshake/engine.
 *   - `error`:  solid red ring, X icon. Used by failure view.
 *
 * Pulse animation is inline-keyframed so this component drops in
 * anywhere without needing a CSS file. Keep that in mind if you
 * find yourself adding a third state - it'd be the moment to
 * promote this to its own .css module.
 */
function StatusOrb({ status }: { status: 'active' | 'error' }) {
  const isError = status === 'error';
  const accent = isError ? STATUS.error : 'primary.main';
  return (
    <Box
      aria-hidden
      sx={{
        position: 'relative',
        width: 96,
        height: 96,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          borderRadius: '50%',
          border: '2px solid',
          borderColor: accent,
          opacity: 0.18,
          ...(isError
            ? {}
            : {
                animation: 'statusOrbPulse 1.6s ease-in-out infinite',
              }),
          '@keyframes statusOrbPulse': {
            '0%': { transform: 'scale(1)', opacity: 0.18 },
            '60%': { transform: 'scale(1.18)', opacity: 0 },
            '100%': { transform: 'scale(1.18)', opacity: 0 },
          },
        }}
      />
      <Box
        sx={{
          width: 64,
          height: 64,
          borderRadius: '50%',
          bgcolor: isError ? `${STATUS.error}1A` : 'action.hover',
          border: '1.5px solid',
          borderColor: accent,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: accent,
        }}
      >
        {isError ? (
          <ErrorRoundedIcon sx={{ fontSize: 28 }} />
        ) : (
          <CircularProgress size={22} thickness={4} />
        )}
      </Box>
    </Box>
  );
}

// ─── Vertical step list ──────────────────────────────────────────────

/**
 * The step list consumes a frozen view of the FSM at render time:
 * each step is one row, the parent decides which row is `active`
 * and (in failure mode) which one is `errored`.
 *
 * Why a flat array of `StepRow` rather than `(activeStep, errored)`?
 *   - The status enum reads like the visual: `completed`/`active`/
 *     `errored`/`pending`. No off-by-one math in the renderer.
 *   - The detail line ("192.168.1.42", "v1.7.4") is per-row, not
 *     derivable from `activeStep` alone, so it had to live on the
 *     row anyway.
 *   - Single source of truth makes future steps (5+) trivial to
 *     add.
 */
export interface StepRow {
  /** Primary label, e.g. "Bluetooth", "Network", "Daemon", "Wake up". */
  label: string;
  /** Optional secondary line: a short observed value (`192.168.1.42`,
   *  `v1.7.4`). `null` collapses the second line entirely. */
  detail: string | null;
  status: 'completed' | 'active' | 'errored' | 'pending';
}

export function HandshakeStepList({ steps }: { steps: readonly StepRow[] }) {
  return (
    <Box
      sx={{
        width: '100%',
        maxWidth: 320,
        display: 'flex',
        flexDirection: 'column',
        gap: 1.25,
        textAlign: 'left',
      }}
    >
      {steps.map((step, index) => (
        <StepRowView key={`${step.label}-${index}`} step={step} />
      ))}
    </Box>
  );
}

function StepRowView({ step }: { step: StepRow }) {
  return (
    <Stack direction="row" spacing={1.5} alignItems="flex-start">
      <Box
        sx={{
          width: 22,
          height: 22,
          flexShrink: 0,
          mt: '2px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <StepIcon status={step.status} />
      </Box>
      <Stack spacing={0.25} sx={{ minWidth: 0, flex: 1 }}>
        <Typography
          sx={{
            fontSize: TYPO.md,
            // Active step gets the accent + semibold weight so the
            // user's eye lands on it without having to read the
            // icon. Errored step is the same but in error red.
            // Completed steps recede in muted text. Pending steps
            // are even lighter, almost ghost.
            color:
              step.status === 'active'
                ? 'primary.main'
                : step.status === 'errored'
                  ? STATUS.error
                  : step.status === 'completed'
                    ? 'text.primary'
                    : 'text.disabled',
            fontWeight:
              step.status === 'active' || step.status === 'errored'
                ? FONT_WEIGHT.semibold
                : FONT_WEIGHT.medium,
            lineHeight: 1.3,
          }}
        >
          {step.label}
          {step.status === 'active' ? '…' : ''}
        </Typography>
        {step.detail ? (
          <Typography
            sx={{
              fontSize: TYPO.xs,
              color: 'text.secondary',
              fontFamily: 'monospace',
              lineHeight: 1.3,
              wordBreak: 'break-word',
            }}
          >
            {step.detail}
          </Typography>
        ) : null}
      </Stack>
    </Stack>
  );
}

function StepIcon({ status }: { status: StepRow['status'] }) {
  if (status === 'completed') {
    return (
      <CheckCircleRoundedIcon
        sx={{ fontSize: 20, color: STATUS.success }}
      />
    );
  }
  if (status === 'errored') {
    return (
      <ErrorRoundedIcon sx={{ fontSize: 20, color: STATUS.error }} />
    );
  }
  if (status === 'active') {
    return <CircularProgress size={16} thickness={5} />;
  }
  return (
    <RadioButtonUncheckedRoundedIcon
      sx={{ fontSize: 18, color: 'text.disabled' }}
    />
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Translate the FSM's `(stepLabels, stepDetails, activeStep, error)`
 * tuple into the `StepRow[]` shape the list renderer expects. Pure
 * function so it's trivial to unit-test in isolation.
 */
export function buildHandshakeSteps(args: {
  labels: readonly string[];
  details: readonly (string | null)[];
  activeStep: number;
  errored: boolean;
}): StepRow[] {
  const { labels, details, activeStep, errored } = args;
  return labels.map((label, index) => {
    let status: StepRow['status'];
    if (index < activeStep) status = 'completed';
    else if (index === activeStep)
      status = errored ? 'errored' : 'active';
    else status = 'pending';
    return {
      label,
      detail: details[index] ?? null,
      status,
    };
  });
}

// ─── Running ─────────────────────────────────────────────────────────

export function HandshakeRunningView({
  robotName,
  transportLabel,
  steps,
  phase,
}: {
  robotName: string;
  /** "USB", "Wi-Fi · 192.168.1.42", "Hugging Face Central" - rendered
   *  under the robot name so the user keeps awareness of which
   *  channel the app is dialing through. */
  transportLabel: string;
  steps: readonly StepRow[];
  /** Drives the small flavour bit at the bottom: 'engine' adds a
   *  reassurance line because the wake-up step takes a few seconds
   *  on its own and we want to acknowledge it. */
  phase: SessionPhase;
}) {
  return (
    <>
      <StatusOrb status="active" />
      <Identity name={robotName} transportLabel={transportLabel} />
      <HandshakeStepList steps={steps} />
      {phase === 'engine' ? (
        <Typography
          sx={{
            fontSize: TYPO.xs,
            color: 'text.secondary',
            fontStyle: 'italic',
            mt: 1,
          }}
        >
          The robot takes a few seconds to wake up.
        </Typography>
      ) : null}
    </>
  );
}

// ─── Identity block (shared) ─────────────────────────────────────────

function Identity({
  name,
  transportLabel,
}: {
  name: string;
  transportLabel: string;
}) {
  return (
    <Stack spacing={0.25} alignItems="center">
      <Typography
        sx={{
          fontSize: TYPO.xl,
          fontWeight: FONT_WEIGHT.semibold,
          letterSpacing: '-0.2px',
          maxWidth: '100%',
        }}
        noWrap
      >
        {name}
      </Typography>
      <Typography
        sx={{
          fontSize: TYPO.sm,
          color: 'text.secondary',
          letterSpacing: '0.2px',
        }}
      >
        via {transportLabel}
      </Typography>
    </Stack>
  );
}

// ─── Ready (post-wake CTA) ───────────────────────────────────────────

/**
 * Rendered as an overlay on top of the (already-mounted) ConversePanel
 * during the 'ready' phase. We deliberately do NOT auto-progress to
 * 'live' on wake-up: the user has to opt in to start the conversation
 * pipeline so the daemon has a moment to settle and the UI doesn't
 * surprise them with the engine's audio prompts.
 *
 * Visually we collapse this view to just the CTA: the robot name and
 * transport are already shown by the always-on `SessionTopBar`, and
 * the rocket illustration was perceived as redundant noise. Keeping
 * only the button puts the whole screen behind a single tap with
 * zero visual competition.
 */
export function HandshakeReadyView({
  robotName: _robotName,
  onStart,
}: {
  /** Kept on the API for callers that still pass it; unused visually. */
  robotName: string;
  onStart: () => void;
}) {
  return (
    <Button
      variant="contained"
      size="large"
      startIcon={<GraphicEqIcon />}
      onClick={onStart}
      sx={{ minWidth: 220, fontWeight: FONT_WEIGHT.semibold }}
    >
      Start conversation
    </Button>
  );
}

// ─── Failure ─────────────────────────────────────────────────────────

export function HandshakeFailureView({
  error,
  steps,
  robotName,
  transportLabel,
  showDetails,
  onToggleDetails,
  onRetry,
  onWifiSetup,
  probeVerdict,
}: {
  error: HandshakeError;
  /** Same step rows passed to the running view. The active row's
   *  status will already be `'errored'` by the parent so the list
   *  paints the failed step in red. */
  steps: readonly StepRow[];
  robotName: string;
  transportLabel: string;
  showDetails: boolean;
  onToggleDetails: () => void;
  onRetry: () => void;
  /** Only present when `error.offerWifiSetup` is true (LAN, no SSID). */
  onWifiSetup?: () => void;
  /**
   * Optional BLE-side reachability snapshot captured by the parent
   * when the failure surfaced. When provided AND the daemon reports
   * something more specific than "everything ok", we override the
   * generic copy carried by `error.title` / `error.body` for an
   * actionable message - and on `daemon=loading` we replace the
   * whole UI with a "robot is just booting, retrying…" spinner
   * since the parent will auto-retry shortly.
   */
  probeVerdict?: BleWifiProbe | 'unsupported' | null;
}) {
  // If the BLE probe says the daemon is finishing boot, render an
  // *info* state instead of a *failure* state: the parent's
  // `useFailureProbe` is going to auto-retry the handshake in a
  // couple of seconds. Surfacing a red orb + "couldn't reach the
  // daemon" copy in between would just confuse the user.
  if (
    probeVerdict !== undefined &&
    probeVerdict !== null &&
    probeVerdict !== 'unsupported' &&
    probeVerdict.daemon === 'loading'
  ) {
    return (
      <DaemonLoadingPlaceholder
        robotName={robotName}
        transportLabel={transportLabel}
      />
    );
  }

  // Pick the actual title + body to display. The probe result, when
  // it carries new information, overrides the generic FSM-supplied
  // copy. If we have nothing better to say (probe unavailable, or
  // every check is `ok`), fall back to whatever the FSM produced.
  const refined = useMemo(
    () =>
      probeVerdict !== undefined && probeVerdict !== null
        ? describeProbeRefinement(probeVerdict)
        : null,
    [probeVerdict],
  );
  const title = refined?.title ?? error.title;
  const body = refined?.body ?? error.body;

  return (
    <>
      <StatusOrb status="error" />
      <Identity name={robotName} transportLabel={transportLabel} />
      <HandshakeStepList steps={steps} />
      <Stack
        spacing={1}
        sx={{
          width: '100%',
          maxWidth: 320,
          textAlign: 'center',
          pt: 0.5,
        }}
      >
        <Typography
          sx={{
            fontSize: TYPO.md,
            fontWeight: FONT_WEIGHT.semibold,
            color: 'text.primary',
          }}
        >
          {title}
        </Typography>
        <Typography
          sx={{
            fontSize: TYPO.sm,
            color: 'text.secondary',
            lineHeight: 1.5,
          }}
        >
          {body}
        </Typography>
      </Stack>
      <Stack spacing={1.25} sx={{ width: '100%', maxWidth: 320, pt: 0.5 }}>
        {error.offerWifiSetup && onWifiSetup ? (
          <Button
            variant="contained"
            color="primary"
            startIcon={<WifiIcon />}
            onClick={onWifiSetup}
            sx={{ fontWeight: FONT_WEIGHT.semibold }}
          >
            Set up Wi-Fi
          </Button>
        ) : null}
        <Button
          variant="outlined"
          color="primary"
          startIcon={<ReplayIcon />}
          onClick={onRetry}
          sx={{ borderWidth: 1.5, '&:hover': { borderWidth: 1.5 } }}
        >
          Retry
        </Button>
        {error.detail ? (
          <Box sx={{ textAlign: 'center', pt: 0.5 }}>
            <Button
              variant="text"
              size="small"
              onClick={onToggleDetails}
              sx={{
                fontSize: TYPO.xs,
                color: 'text.secondary',
                textTransform: 'none',
                opacity: 0.7,
                '&:hover': { opacity: 1, bgcolor: 'transparent' },
              }}
            >
              {showDetails ? 'Hide details' : 'Details'}
            </Button>
            <Collapse in={showDetails}>
              <Typography
                sx={{
                  display: 'block',
                  fontSize: TYPO.xs,
                  color: 'text.secondary',
                  fontFamily: 'monospace',
                  mt: 1,
                  p: 1.5,
                  borderRadius: RADIUS.sm,
                  bgcolor: 'action.hover',
                  wordBreak: 'break-all',
                  textAlign: 'left',
                }}
              >
                {error.detail}
              </Typography>
            </Collapse>
          </Box>
        ) : null}
      </Stack>
    </>
  );
}

/**
 * Transient placeholder shown when the BLE probe revealed the daemon
 * is just finishing boot and the parent is about to auto-retry the
 * handshake. We deliberately avoid the failure orb + "Couldn't reach
 * the daemon" copy here: this is a non-failure case (the robot is
 * healthy, just slow), and the user shouldn't have to tap Retry to
 * make progress.
 *
 * Visually we keep the same identity block as the running view so
 * the orb-shape change (active orb → rocket icon) reads as a
 * specialisation rather than a screen swap.
 */
function DaemonLoadingPlaceholder({
  robotName,
  transportLabel,
}: {
  robotName: string;
  transportLabel: string;
}) {
  return (
    <>
      <Box
        aria-hidden
        sx={{
          position: 'relative',
          width: 96,
          height: 96,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            borderRadius: '50%',
            border: '2px solid',
            borderColor: 'primary.main',
            opacity: 0.18,
            animation: 'daemonLoadingPulse 1.6s ease-in-out infinite',
            '@keyframes daemonLoadingPulse': {
              '0%': { transform: 'scale(1)', opacity: 0.18 },
              '60%': { transform: 'scale(1.18)', opacity: 0 },
              '100%': { transform: 'scale(1.18)', opacity: 0 },
            },
          }}
        />
        <Box
          sx={{
            width: 64,
            height: 64,
            borderRadius: '50%',
            bgcolor: 'action.hover',
            border: '1.5px solid',
            borderColor: 'primary.main',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'primary.main',
          }}
        >
          <RocketLaunchRoundedIcon sx={{ fontSize: 28 }} />
        </Box>
      </Box>
      <Identity name={robotName} transportLabel={transportLabel} />
      <Stack alignItems="center" spacing={1}>
        <Typography
          sx={{
            fontSize: TYPO.md,
            fontWeight: FONT_WEIGHT.semibold,
            color: 'text.primary',
            textAlign: 'center',
          }}
        >
          Robot is finishing boot
        </Typography>
        <Typography
          sx={{
            fontSize: TYPO.sm,
            color: 'text.secondary',
            textAlign: 'center',
            maxWidth: 320,
            lineHeight: 1.5,
          }}
        >
          The daemon is still loading. We&apos;ll continue automatically
          as soon as it&apos;s ready.
        </Typography>
      </Stack>
    </>
  );
}

// ─── Leaving view ────────────────────────────────────────────────────
//
// Lives in its own module: `./LeavingView.tsx`. Re-imported from
// `RobotSessionScreen.tsx` directly. The teardown view borrows this
// file's `HandshakeStepList` (and `StepRow` type) for its checklist
// rendering, but ships its own minimal chrome (no orb, no identity
// block) + `LeavingStep` projection logic - keeps the controller-
// side `LeavingStep` type out of this module.
