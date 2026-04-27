/**
 * Unified post-discovery screen for both LAN (BLE) and remote (HF
 * central) connections.
 *
 * Architecture
 * ────────────
 * This file is intentionally thin. It is just the *layout* layer:
 *
 *   - `useSessionController` owns every piece of session logic (FSM,
 *     handshake, daemon probe, wake/sleep, teardown, relay heal, HF
 *     auto-seed, structured connection log).
 *   - The sub-views in `./session/` own pure rendering. They take
 *     plain props + `() => void` callbacks and don't know about the
 *     FSM.
 *   - This file picks which sub-view to render given the FSM phase,
 *     and forwards user gestures back through the controller's
 *     command surface (`controller.retry`, `controller.back`, …).
 *
 * Single transport, two discovery paths
 * ─────────────────────────────────────
 * BLE and HF central are two ways to FIND a robot, not two ways to
 * TALK to it. Once we land on this screen, every daemon API call goes
 * through the same WebRTC `http_proxy` channel (see
 * `robot-client/index.ts`). ICE quietly picks a LAN host candidate
 * when both peers are on the same subnet and a TURN-relayed remote
 * one otherwise, so "prefer LAN when reachable" is automatic without
 * dual code paths.
 *
 * BLE keeps a small but real role even after this collapse:
 *   - Wi-Fi provisioning (the user can hand the robot credentials
 *     before central can see it at all).
 *   - Proof of physical proximity (the BLE list is curated by who is
 *     literally next to the robot, central is curated by the HF
 *     account that owns it).
 *   - Local-side bootstraps that need direct LAN HTTP because the
 *     daemon does not yet hold an HF token (auto-seed of `/api/hf-
 *     auth/save-token`, the daemon-mediated OAuth menu).
 *
 * Lifecycle phases (owned by `sessionFsm.ts`)
 * ───────────────────────────────────────────
 *   handshake → engine → ready → live → leaving
 *
 * See the FSM module header for the full transition table and what
 * each event represents.
 */
import { useState } from 'react';
import { Box, Stack } from '@mui/material';

import ForgetWifiDialog from '../components/ForgetWifiDialog';
import NameRobotPanel from '../components/NameRobotPanel';
import StepperHeader from '../components/StepperHeader';
import { DEFAULT_ROBOT_NAME } from '../daemon/robotName';
import {
  useSessionController,
  type SessionController,
} from '../session/useSessionController';
import type { ConnectionTarget } from '../session/sessionFsm';

import { ConversationView } from './session/ConversationView';
import {
  HandshakeFailureView,
  HandshakeRunningView,
  LeavingView,
} from './session/HandshakeViews';
import { SessionTopBar } from './session/SessionTopBar';

// Re-export so existing call sites (`App.tsx`) keep working.
export type { ConnectionTarget };

export interface RobotSessionScreenProps {
  target: ConnectionTarget;
  /** HF username (for remote subtitle and the menu's identity row). */
  username: string | null;
  /**
   * HF access token from the app-level gate. Used in LAN mode to
   * silently seed the daemon's own HF auth via `POST
   * /api/hf-auth/save-token` the first time we connect, so the user
   * does not see a second sign-in prompt for what is conceptually
   * the same account.
   */
  hfToken: string | null;
  onBack: () => void;
  /** Local-only: robot has no Wi-Fi yet, route to setup. */
  onNeedsWifi?: () => void;
}

export default function RobotSessionScreen(props: RobotSessionScreenProps) {
  // Mandatory naming gate for the localhost variant: the discovery
  // probe surfaces the daemon even when it's still using the default
  // `reachy_mini` label, but a session with an unnamed daemon is
  // ambiguous (peer-id resolution would match by name and pick the
  // wrong one when several robots share the default). We block the
  // session from mounting at all until the user has named the robot,
  // then re-enter with the freshly-applied name as the new target.
  //
  // BLE (`local`) does not need this gate because `WifiSetupScreen`
  // already enforces naming before navigating here. Remote
  // (`remote`) by construction can't appear with a default name -
  // the daemon-side relay is gated off until naming happens.
  const [activeTarget, setActiveTarget] = useState<ConnectionTarget>(
    props.target,
  );
  const requiresNaming =
    activeTarget.kind === 'localhost' &&
    activeTarget.robotName === DEFAULT_ROBOT_NAME;

  if (requiresNaming && activeTarget.kind === 'localhost') {
    return (
      <Stack
        sx={{
          height: '100%',
          width: '100%',
          bgcolor: 'background.default',
          alignItems: 'center',
          justifyContent: 'center',
          px: 3,
        }}
      >
        <NameRobotPanel
          host={activeTarget.host}
          initialName=""
          subtitle="This Reachy is running on your Mac and needs a name before you can start a session. You can rename it later from Settings."
          onSaved={(info) => {
            setActiveTarget({
              kind: 'localhost',
              host: activeTarget.host,
              robotName: info.name,
            });
          }}
          onCancel={props.onBack}
        />
      </Stack>
    );
  }

  return <SessionContent {...props} target={activeTarget} />;
}

function SessionContent({
  target,
  username,
  hfToken,
  onBack,
  onNeedsWifi,
}: RobotSessionScreenProps) {
  const controller = useSessionController({
    target,
    username,
    hfToken,
    onBack,
    onNeedsWifi,
  });

  // Pure UI state stays at the screen level: not session-scoped, only
  // meaningful while the matching JSX is rendered, no need to plumb
  // it through the controller.
  const [showHandshakeDetails, setShowHandshakeDetails] = useState(false);
  const [forgetOpen, setForgetOpen] = useState(false);

  const phase = controller.state.phase;
  const isAuthenticated = controller.isLocal
    ? controller.auth.isAuthenticated
    : true;
  // The ConversePanel must be mounted as soon as we leave 'handshake':
  // its DataChannel IS the daemon proxy transport, so wake-up,
  // setMotorMode, and the daemon-status pill all need it. The panel's
  // `convoActive` prop separately gates the conversation pipeline.
  const shouldMountPanel = phase !== 'handshake';

  return (
    <Stack sx={{ height: '100%', bgcolor: 'background.default' }}>
      <SessionTopBar
        robotName={controller.displayName}
        subtitle={controller.subtitle}
        onBack={controller.back}
        backDisabled={phase === 'leaving'}
        showMenu={phase === 'ready' || phase === 'live'}
        isLocal={controller.isLocal}
        onForgetWifi={() => setForgetOpen(true)}
        onDisconnect={controller.back}
        auth={controller.auth}
      />

      {/* Stepper visible during handshake + engine only. Once the
          robot is awake we drop it entirely and surface the final
          chrome (top-bar menu + bottom-nav tabs). The "Start
          conversation" CTA then lives inside the converse tab so the
          user is already in the post-connect surface. */}
      {(phase === 'handshake' || phase === 'engine') && (
        <Box sx={{ px: 3, pt: 2, pb: 1, bgcolor: 'background.default' }}>
          <StepperHeader
            steps={controller.stepLabels as unknown as readonly string[]}
            activeStep={controller.state.activeStep}
            error={controller.state.error !== null}
          />
        </Box>
      )}

      {/* Body: handshake hero / failure / leaving spinner are
          rendered as an overlay on top of the (eventually mounted)
          ConversePanel, so the SDK negotiation can keep running
          underneath without the user seeing a flash on phase
          transitions. */}
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {(phase === 'handshake' ||
          phase === 'engine' ||
          phase === 'leaving') && (
          <Stack
            alignItems="center"
            justifyContent="center"
            spacing={2.5}
            sx={{
              position: 'absolute',
              inset: 0,
              zIndex: 2,
              bgcolor: 'background.default',
              px: 3,
              pb: 4,
              textAlign: 'center',
            }}
          >
            {renderBringUpCell({
              controller,
              showHandshakeDetails,
              setShowHandshakeDetails,
            })}
          </Stack>
        )}

        {shouldMountPanel ? (
          <ConversationView
            controller={controller}
            isAuthenticated={isAuthenticated}
          />
        ) : null}
      </Box>

      <ForgetWifiDialog
        open={forgetOpen}
        robotName={controller.displayName}
        client={controller.robotClient}
        onClose={() => setForgetOpen(false)}
        onForgotten={() => {
          setForgetOpen(false);
          controller.back();
        }}
      />
    </Stack>
  );
}

/**
 * Picks the bring-up cell to render given the FSM state. Inlined as
 * a helper rather than a component so the parent's `<Stack>` keeps
 * being the layout anchor (each view contributes flat children, not
 * a nested stack).
 */
function renderBringUpCell({
  controller,
  showHandshakeDetails,
  setShowHandshakeDetails,
}: {
  controller: SessionController;
  showHandshakeDetails: boolean;
  setShowHandshakeDetails: (next: boolean | ((prev: boolean) => boolean)) => void;
}) {
  const { state } = controller;
  if (state.phase === 'leaving') {
    return <LeavingView />;
  }
  if (state.error) {
    return (
      <HandshakeFailureView
        error={state.error}
        showDetails={showHandshakeDetails}
        onToggleDetails={() => setShowHandshakeDetails((v) => !v)}
        onRetry={controller.retry}
        onWifiSetup={
          state.error.offerWifiSetup ? controller.needsWifi : undefined
        }
      />
    );
  }
  return (
    <HandshakeRunningView
      stepLabel={
        controller.stepLabels[
          Math.min(state.activeStep, controller.stepLabels.length - 1)
        ]
      }
      robotName={controller.displayName}
      phase={state.phase}
    />
  );
}
