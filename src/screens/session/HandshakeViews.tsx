/**
 * Handshake-phase views.
 *
 * The session screen renders one of these three cells while
 * `phase ∈ {'handshake', 'engine'}`:
 *
 *   HandshakeRunningView - default during bring-up, shows the active
 *                          step label and a hero illustration (rocket
 *                          while waking, astronaut while pre-handshake).
 *   HandshakeFailureView - replaces the running view as soon as the
 *                          FSM holds a non-null error. Surfaces both
 *                          BLE/peer-id failures and post-engine wake
 *                          failures (which the FSM funnels back into
 *                          the handshake phase via `engine.wake_failed`
 *                          → 'handshake').
 *   HandshakeReadyView   - rendered by the conversation view as an
 *                          overlay during 'ready'. Lives here because
 *                          it's a sibling of the two above and shares
 *                          the same hero illustration shape.
 *
 * None of these components are aware of the FSM. They take plain
 * strings + `() => void` callbacks; the parent does the bridging.
 */
import { Box, Button, CircularProgress, Collapse, Stack, Typography } from '@mui/material';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import ReplayIcon from '@mui/icons-material/Replay';
import WifiIcon from '@mui/icons-material/Wifi';

import HeroIllustration from '../../components/HeroIllustration';
import astronautSvg from '../../assets/astronaut.svg';
import connectionLostSvg from '../../assets/connection-lost.svg';
import rocketSvg from '../../assets/rocket.svg';
import type { HandshakeError, SessionPhase } from '../../session/sessionFsm';
import { FONT_WEIGHT, LAYOUT, STATUS, TYPO } from '../../styles/tokens';

// ─── Running ─────────────────────────────────────────────────────────

export function HandshakeRunningView({
  stepLabel,
  robotName,
  phase,
}: {
  stepLabel: string;
  robotName: string;
  /** Drives illustration + label cosmetics: 'engine' shows the rocket
   * + "Waking up…", anything else shows the astronaut + the active
   * step label from the FSM. */
  phase: SessionPhase;
}) {
  return (
    <>
      <HeroIllustration
        src={phase === 'engine' ? rocketSvg : astronautSvg}
        alt={robotName}
        animation={phase === 'engine' ? 'pulse' : 'float'}
        size={LAYOUT.heroSize}
        mb={0.5}
      />
      <Typography
        sx={{
          fontSize: TYPO.xl,
          fontWeight: FONT_WEIGHT.semibold,
          letterSpacing: '-0.2px',
          maxWidth: '100%',
        }}
        noWrap
      >
        {robotName}
      </Typography>
      <Stack alignItems="center" spacing={1}>
        <CircularProgress size={18} thickness={4} />
        <Typography sx={{ fontSize: TYPO.md, color: 'text.secondary' }}>
          {phase === 'engine' ? 'Waking up…' : `${stepLabel}…`}
        </Typography>
      </Stack>
    </>
  );
}

// ─── Ready (post-wake CTA) ───────────────────────────────────────────

/**
 * Rendered as an overlay on top of the (already-mounted) ConversePanel
 * during the 'ready' phase. We deliberately do NOT auto-progress to
 * 'live' on wake-up: the user has to opt in to start the conversation
 * pipeline so the daemon has a moment to settle and the UI doesn't
 * surprise them with the engine's audio prompts.
 */
export function HandshakeReadyView({
  robotName,
  onStart,
}: {
  robotName: string;
  onStart: () => void;
}) {
  return (
    <>
      <HeroIllustration
        src={rocketSvg}
        alt={robotName}
        animation="float"
        size={LAYOUT.heroSize}
        mb={0.5}
      />
      <Typography
        sx={{
          fontSize: TYPO.xl,
          fontWeight: FONT_WEIGHT.semibold,
          letterSpacing: '-0.2px',
          maxWidth: '100%',
        }}
        noWrap
      >
        {robotName}
      </Typography>
      <Typography sx={{ fontSize: TYPO.md, color: 'text.secondary' }}>
        Ready to talk.
      </Typography>
      <Button
        variant="contained"
        size="large"
        startIcon={<GraphicEqIcon />}
        onClick={onStart}
        sx={{ mt: 1.5, minWidth: 220, fontWeight: FONT_WEIGHT.semibold }}
      >
        Start conversation
      </Button>
    </>
  );
}

// ─── Failure ─────────────────────────────────────────────────────────

export function HandshakeFailureView({
  error,
  showDetails,
  onToggleDetails,
  onRetry,
  onWifiSetup,
}: {
  error: HandshakeError;
  showDetails: boolean;
  onToggleDetails: () => void;
  onRetry: () => void;
  /** Only present when `error.offerWifiSetup` is true (LAN, no SSID). */
  onWifiSetup?: () => void;
}) {
  return (
    <>
      <HeroIllustration
        src={connectionLostSvg}
        alt="Connection lost"
        animation="float"
        size={LAYOUT.heroSize}
        mb={0.5}
      />
      <Typography
        sx={{
          fontSize: TYPO.xl,
          fontWeight: FONT_WEIGHT.semibold,
          color: 'text.primary',
        }}
      >
        {error.title}
      </Typography>
      <Typography
        sx={{
          fontSize: TYPO.sm,
          color: 'text.secondary',
          lineHeight: 1.5,
          maxWidth: 320,
        }}
      >
        {error.body}
      </Typography>
      <Stack spacing={1.25} sx={{ width: '100%', maxWidth: 320, pt: 1 }}>
        {error.offerWifiSetup && onWifiSetup ? (
          <button
            onClick={onWifiSetup}
            style={{
              all: 'unset',
              cursor: 'pointer',
              padding: '12px 16px',
              borderRadius: 8,
              backgroundColor: STATUS.info,
              color: '#fff',
              fontWeight: 600,
              textAlign: 'center',
              fontSize: '0.95rem',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              justifyContent: 'center',
            }}
          >
            <WifiIcon fontSize="small" /> Set up Wi-Fi
          </button>
        ) : null}
        <button
          onClick={onRetry}
          style={{
            all: 'unset',
            cursor: 'pointer',
            padding: '10px 16px',
            borderRadius: 8,
            border: `1px solid ${STATUS.info}`,
            color: STATUS.info,
            fontWeight: 500,
            textAlign: 'center',
            fontSize: '0.9rem',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            justifyContent: 'center',
          }}
        >
          <ReplayIcon fontSize="small" /> Retry
        </button>
        {error.detail ? (
          <Box sx={{ textAlign: 'center', pt: 0.5 }}>
            <button
              onClick={onToggleDetails}
              style={{
                all: 'unset',
                cursor: 'pointer',
                opacity: 0.6,
                fontSize: TYPO.xs,
                padding: '4px 8px',
              }}
            >
              {showDetails ? 'Hide details' : 'Details'}
            </button>
            <Collapse in={showDetails}>
              <Typography
                sx={{
                  display: 'block',
                  fontSize: TYPO.xs,
                  color: 'text.secondary',
                  fontFamily: 'monospace',
                  mt: 1,
                  p: 1.5,
                  borderRadius: 1,
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

// ─── Leaving spinner ─────────────────────────────────────────────────

export function LeavingView() {
  return (
    <>
      <CircularProgress size={28} />
      <Typography variant="body2" color="text.secondary">
        Disconnecting…
      </Typography>
    </>
  );
}
