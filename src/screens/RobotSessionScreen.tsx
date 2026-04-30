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
import { useEffect, useState } from 'react';
import { Box, Stack } from '@mui/material';

import { useBleSession } from '../ble/useBleSession';
import ForgetWifiDialog from '../components/ForgetWifiDialog';
import {
  useSessionController,
  type SessionController,
} from '../session/useSessionController';
import type { ConnectionTarget } from '../session/sessionFsm';
import type { BleWifiProbe } from '../types/robot';
import { probeWithRetry, useWifiSetup } from '../wifi/useWifiSetup';

import { ConversationView } from './session/ConversationView';
import {
  buildHandshakeSteps,
  HandshakeFailureView,
  HandshakeRunningView,
  type StepRow,
} from './session/HandshakeViews';
import { LeavingView } from './session/LeavingView';
import { SessionTopBar } from './session/SessionTopBar';

/**
 * Auto-retry delay when the BLE-side probe tells us the daemon is
 * just finishing boot. 3 s gives the daemon's `state` field a beat
 * to flip from `loading` to `running` before we re-issue the
 * handshake - long enough that we don't spin uselessly, short
 * enough that the user perceives it as continuous progress (no
 * failure UI in between).
 */
const PROBE_AUTO_RETRY_DELAY_MS = 3_000;

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
  // Naming is no longer a hard gate. Reconciliation across BLE / mDNS
  // / loopback / HF central is done by the stable `install_id`, so an
  // unnamed `reachy_mini` is uniquely identifiable and a session can
  // safely mount on it. The user can pick a friendly label later from
  // Settings (or be prompted opportunistically by the discovery list,
  // which already disambiguates via an install_id suffix).
  return <SessionContent {...props} target={props.target} />;
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

  // BLE-driven failure diagnostic. When the handshake fails AND we
  // happen to have an open BLE link to this robot, ask the daemon to
  // probe its own connectivity - the verdict drives a richer failure
  // message and, on `daemon=loading`, a one-shot auto-retry that
  // bypasses the failure UI entirely. See `useFailureProbe` for the
  // full lifecycle.
  const ble = useBleSession();
  const wifiSetup = useWifiSetup();
  const handshakeError = controller.state.error;
  const { probeVerdict } = useFailureProbe({
    error: handshakeError,
    bleConnectedAddress: ble.connectedAddress,
    wifiSetup,
    retry: controller.retry,
  });

  const phase = controller.state.phase;
  const isAuthenticated = controller.isLocal
    ? controller.auth.isAuthenticated
    : true;

  // The "Forget Wi-Fi" affordance only makes sense for the wireless
  // Reachy variant: the USB / Mac-tray case has no Wi-Fi config to
  // wipe, so showing the entry would be misleading. We trust three
  // signals in order:
  //   - BLE target → always wireless (BLE chip is exclusive to the
  //     wireless variant);
  //   - HF target with `meta.wireless_version === true` → wireless;
  //   - HF target with `meta.wireless_version === false` → USB-via-tray;
  //   - localhost (USB) target → never wireless.
  // Legacy daemons that don't publish `wireless_version` over central
  // collapse to "hidden" so the menu is conservative rather than
  // over-promising.
  const showForgetWifi = (() => {
    if (target.kind === 'local') return true;
    if (target.kind === 'localhost') return false;
    return target.robot.meta?.wireless_version === true;
  })();
  // The ConversePanel must be mounted as soon as we leave 'handshake':
  // its DataChannel IS the daemon proxy transport, so wake-up,
  // setMotorMode, and the daemon-status pill all need it. The panel's
  // `convoActive` prop separately gates the conversation pipeline.
  const shouldMountPanel = phase !== 'handshake';

  return (
    <Stack sx={{ height: '100%', bgcolor: 'background.default' }}>
      <SessionTopBar
        robotName={controller.displayName}
        installIdSuffix={controller.installIdSuffix}
        transport={controller.transport}
        endpoint={controller.endpoint}
        statusText={controller.statusText}
        motorState={controller.motorState}
        daemonVersion={controller.daemonVersion?.version ?? null}
        onBack={controller.back}
        backDisabled={phase === 'leaving'}
        showMenu={phase === 'ready' || phase === 'live'}
        showForgetWifi={showForgetWifi}
        onForgetWifi={() => setForgetOpen(true)}
        onDisconnect={controller.back}
      />

      {/* The horizontal stepper that used to live up here was
          removed when the bring-up cell got reworked: the new
          `HandshakeRunningView` already renders a centred vertical
          step list as part of its own composition, and pinning a
          duplicate stepper at the top created two competing visual
          centres on a 4-inch screen. */}

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
              probeVerdict,
              transportLabel: describeTransport(
                controller.transport,
                controller.endpoint,
              ),
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
  probeVerdict,
  transportLabel,
}: {
  controller: SessionController;
  showHandshakeDetails: boolean;
  setShowHandshakeDetails: (next: boolean | ((prev: boolean) => boolean)) => void;
  /** Latest BLE WIFI_PROBE verdict captured on failure - lets the
   *  failure view swap its generic copy for an actionable one. */
  probeVerdict: BleWifiProbe | 'unsupported' | null;
  /** "USB", "Wi-Fi · 192.168.1.42", "Hugging Face Central" — used as
   *  a sub-line in the running view so the user keeps awareness of
   *  which channel the app is dialing through. */
  transportLabel: string;
}) {
  const { state } = controller;
  if (state.phase === 'leaving') {
    return (
      <LeavingView
        robotName={controller.displayName}
        step={controller.leavingStep}
        isLocal={controller.isLocal}
      />
    );
  }
  // Both the running and failure views render the same vertical
  // step list. We build the rows once here and pass them down: the
  // failure variant only needs to know that the active row should
  // render in error red, which `buildHandshakeSteps` encodes by
  // flipping that row's status when `errored: true`.
  // We pass `displayedActiveStep` (not `state.activeStep`) so the
  // REMOTE flow's collapsed "Hugging Face" step doesn't shift the
  // visible row math.
  const steps: readonly StepRow[] = buildHandshakeSteps({
    labels: controller.stepLabels,
    details: controller.stepDetails,
    activeStep: controller.displayedActiveStep,
    errored: state.error !== null,
  });
  if (state.error) {
    return (
      <HandshakeFailureView
        error={state.error}
        steps={steps}
        robotName={controller.displayName}
        transportLabel={transportLabel}
        showDetails={showHandshakeDetails}
        onToggleDetails={() => setShowHandshakeDetails((v) => !v)}
        onRetry={controller.retry}
        onWifiSetup={
          state.error.offerWifiSetup ? controller.needsWifi : undefined
        }
        probeVerdict={probeVerdict}
      />
    );
  }
  return (
    <HandshakeRunningView
      robotName={controller.displayName}
      transportLabel={transportLabel}
      steps={steps}
      phase={state.phase}
    />
  );
}

/**
 * Map the controller's compact transport tag to a label we can show
 * mid-handshake. Two formats:
 *
 *   - LAN (BLE / USB): include the live endpoint when available so
 *     the user can sanity-check it ("Wi-Fi · 192.168.1.42",
 *     "USB · 127.0.0.1").
 *   - Remote (HF): just the friendly product name. The endpoint here
 *     is a peer ID, of zero use to a human.
 *
 * Empty endpoint (BLE pre-network step, remote target) collapses to
 * the bare channel name, never an awkward "Wi-Fi · ".
 */
function describeTransport(
  transport: 'BLE' | 'USB' | 'HF',
  endpoint: string,
): string {
  if (transport === 'HF') return 'Hugging Face Central';
  const channel = transport === 'BLE' ? 'Wi-Fi' : 'USB';
  if (endpoint && endpoint.length > 0) return `${channel} · ${endpoint}`;
  return channel;
}

// ─── Probe-on-failure orchestration ──────────────────────────────────

/**
 * Fires a single `WIFI_PROBE` over the still-open BLE link as soon as
 * the handshake reports an error, and auto-retries the handshake when
 * the probe says the daemon is just finishing boot.
 *
 * Lifecycle
 * ─────────
 *   1. `error` flips from null → set, BLE is connected ⇒ fire
 *      `probeWithRetry()` once. The result lives in `probeVerdict`
 *      until the next retry resets it.
 *   2. If `verdict.daemon === 'loading'`, schedule one retry of the
 *      handshake after `PROBE_AUTO_RETRY_DELAY_MS`. The user never
 *      sees a failure card in this case - just a brief spinner that
 *      morphs back into "Waking up…".
 *   3. On `error` reset (the user tapped Retry, or the next attempt
 *      succeeded), `probeVerdict` is cleared so the next failure
 *      starts from a clean slate.
 *
 * Skips entirely when no BLE link is available (central-only target,
 * BLE was already torn down, etc.) - the rest of the failure UI works
 * exactly as before.
 */
function useFailureProbe(args: {
  error: ReturnType<typeof useSessionController>['state']['error'];
  bleConnectedAddress: string | null;
  wifiSetup: ReturnType<typeof useWifiSetup>;
  retry: () => void;
}): { probeVerdict: BleWifiProbe | 'unsupported' | null } {
  const { error, bleConnectedAddress, wifiSetup, retry } = args;
  const [probeVerdict, setProbeVerdict] = useState<
    BleWifiProbe | 'unsupported' | null
  >(null);

  // Step 1 + 3: fetch on new error, clear on error reset.
  useEffect(() => {
    if (!error) {
      setProbeVerdict(null);
      return;
    }
    if (!bleConnectedAddress) return;
    let cancelled = false;
    void probeWithRetry(wifiSetup).then((verdict) => {
      if (cancelled) return;
      if (verdict !== null) setProbeVerdict(verdict);
    });
    return () => {
      cancelled = true;
    };
  }, [error, bleConnectedAddress, wifiSetup]);

  // Step 2: auto-retry when the daemon is just booting.
  useEffect(() => {
    if (probeVerdict === null || probeVerdict === 'unsupported') return;
    if (probeVerdict.daemon !== 'loading') return;
    const handle = window.setTimeout(() => {
      setProbeVerdict(null);
      retry();
    }, PROBE_AUTO_RETRY_DELAY_MS);
    return () => window.clearTimeout(handle);
  }, [probeVerdict, retry]);

  return { probeVerdict };
}
