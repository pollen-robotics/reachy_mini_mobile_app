/**
 * Robot session screen.
 *
 * Three-tab shell hosted on a single connected robot
 * (Conversation | Apps | Telepresence; the telepresence tab takes the
 * whole screen, see `<TelepresencePanel>`):
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ Header (name + chips + [ⓘ info] + [⏻ off])   │
 *   ├──────────────────────────────────────────────┤
 *   │                                              │
 *   │       Tab body  (Conversation | Apps)        │
 *   │                                              │
 *   ├──────────────────────────────────────────────┤
 *   │ BottomNavigation : [Conv]      [Apps]        │
 *   └──────────────────────────────────────────────┘
 *
 * The standalone `Robot` tab (camera + joystick + log tail +
 * WebRTC overlay) was deleted: camera + manual head steering moved
 * to the dedicated telepresence app where they belong, and the
 * diagnostic signals (transport / version / IP / live logs) live
 * in an on-demand `<RobotInfoSheet>` triggered by the `ⓘ` button
 * in the topbar. The tab took a full bottom-nav slot for a surface
 * the user rarely needed; the sheet is the right granularity for
 * "occasionally I want to peek at the daemon".
 *
 * Architectural separation (A / B / C / D layers)
 * ───────────────────────────────────────────────
 * `useRobotSession` owns A + B + C: HF auth + WebRTC session +
 * physical posture (wake / sleep). The screen orchestrates the
 * session through that hook and pipes user actions into it.
 *
 * `<ConversationPanel>` is a pure D-layer consumer: it renders the
 * orb chrome from `session.connectionState` + `session.conversationState`
 * and forwards user gestures to `session.triggerOrbAction()` /
 * `session.setMicMuted()` etc.
 * It never decides when to connect, when to wake, or when to put
 * the robot to sleep.
 *
 * `<AppIframeOverlay>` is another consumer: it asks the session to
 * release the WebRTC slot (via `session.releaseForHandoff()`) before
 * the iframe dials in, and asks for it back on close (via
 * `session.reacquire()`). The robot stays awake throughout.
 *
 * `<RobotInfoPanel>` is a third consumer: it surfaces the daemon
 * version (via `useDaemonState`), the live WebRTC transport
 * signals (kind / IP / bitrate), and the daemon's log tail (via
 * `session.subscribeLogs`). Rendered as a `position: fixed`
 * overlay pinned BELOW the session topbar (covers body + bottom
 * nav, but never the topbar) so the user always sees which robot
 * they're inspecting via the chips at the top and can dismiss by
 * tapping the same button they opened with (the topbar's info
 * glyph swaps to a `✕` while the panel is open).
 *
 * Tabs are independent of the session lifecycle: switching tabs
 * does NOT release the WebRTC session; only OPENING an app does.
 * That matches the user's mental model ("I'm just browsing - the
 * robot is still listening to me" vs "I'm in this app now - the
 * robot is talking to it"). The Conv pipeline (D layer) IS stopped
 * on tab-switch because it's the only piece whose silence-while-
 * background is actually surprising / wasteful.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import {
  BottomNavigation,
  BottomNavigationAction,
  Box,
  CircularProgress,
  Fade,
  IconButton,
  Stack,
  Typography,
  alpha,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CloseIcon from '@mui/icons-material/Close';
import PowerSettingsNewIcon from '@mui/icons-material/PowerSettingsNew';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import VideocamOutlinedIcon from '@mui/icons-material/VideocamOutlined';

import AppsIcon from '@/ui/design/icons/AppsIcon';
import ChatBubbleIcon from '@/ui/design/icons/ChatBubbleIcon';

import {
  extractRobotHardwareId,
  extractRobotId,
  extractRobotName,
  extractRobotTransport,
  type CentralRobotEntry,
} from '@/features/auth/fetchRobotsFromCentral';
import { ConversationPanel } from '@/ui/panels/conversation/ConversationPanel';
import { ConversationSettingsPanel } from '@/ui/panels/conversation/ConversationSettingsPanel';
import { useRobotSession } from '@/features/robot-session/useRobotSession';
import { rememberRobotPersona, useActivePersonality } from '@/features/personalities';
import { useChangePersonaAnimation } from '@/features/personalities/useChangePersonaAnimation';
import { DaemonStateProvider } from '@/features/daemon-state';
import type { AppEntry } from '@/features/apps/types';
import AppIframeOverlay from '@/ui/panels/apps-list/AppIframeOverlay';
import AppsTabView, { type AppsTabViewHandle } from '@/ui/panels/apps-list/AppsTabView';
import TelepresencePanel from '@/ui/panels/telepresence/TelepresencePanel';
import ConnectingView from './session/ConnectingView';
import DaemonUpdateGate from './session/DaemonUpdateGate';
import FirstWakeUpWizard from './session/first-wake-up';
import {
  ONBOARDING_MOVES_DATASET,
  ONBOARDING_PRELOAD_TIMEOUT_MS,
} from './session/first-wake-up/constants';
import IdentityChipBar from '@/ui/widgets/IdentityChipBar';
import LeavingView from './session/LeavingView';
import ReconnectingView from './session/ReconnectingView';
import RobotInfoPanel from './session/RobotInfoPanel';
import SessionErrorView from './session/SessionErrorView';
import { isDaemonOutdated, useLatestDaemonVersion } from '@/features/daemon-update/latestRelease';
import { FONT_WEIGHT, LAYOUT, TYPO } from '@/ui/design/tokens';
import { useKeepScreenOn } from '@/shared/tauri/useKeepScreenOn';

export type ConnectionTarget = {
  kind: 'remote';
  robot: CentralRobotEntry;
};

interface RobotSessionScreenProps {
  target: ConnectionTarget;
  token: string;
  username: string | null;
  onBack: () => void;
}

type Tab = 'conv' | 'apps' | 'tele';

export default function RobotSessionScreen({
  target,
  token,
  username,
  onBack,
}: RobotSessionScreenProps) {
  const robotId = extractRobotId(target.robot);
  const robotName = extractRobotName(target.robot) ?? robotId ?? 'Reachy Mini';
  const robotHardwareId = extractRobotHardwareId(target.robot);
  const robotTransport = extractRobotTransport(target.robot);

  // Defensive early-return: a listing without a peer id can't be
  // routed by the SDK. Render a dedicated screen so the user has a
  // clear way out without sitting through a doomed engine bring-up.
  if (!robotId) {
    return <NoPeerIdView robotName={robotName} onBack={onBack} />;
  }

  return (
    <ConnectedSession
      robotId={robotId}
      robotName={robotName}
      robotHardwareId={robotHardwareId}
      robotTransport={robotTransport}
      token={token}
      username={username}
      onBack={onBack}
    />
  );
}

interface ConnectedSessionProps {
  robotId: string;
  robotName: string;
  robotHardwareId: string | null;
  robotTransport: string;
  token: string;
  username: string | null;
  onBack: () => void;
}

/**
 * Master switch for the first wake-up wizard. When `false`, the wizard
 * never mounts AND the bring-up wakes the robot itself as usual, on the
 * first connection and on every reconnect.
 */
const FIRST_WAKE_UP_WIZARD_ENABLED = true;

/**
 * Dev-only escape hatch. When `true` (the default in dev) the wizard runs
 * on EVERY connection, ignoring the robot's persisted "completed" flag, so
 * we always exercise the flow while iterating. Flip to `false` to respect
 * the flag like production (wizard shows once, then never again until the
 * robot's flag is reset). No effect in production builds - there the
 * persisted robot-side flag always governs.
 *
 * "Relaunches on every Reachy startup" falls out of this naturally: the
 * flag lives on the robot, so it's the same first-connection decision each
 * time the daemon (re)starts.
 */
const FORCE_FIRST_WAKE_UP_IN_DEV = true;

/**
 * Wizard gate resolution.
 *  - `pending`: we don't yet know whether to show it (querying the robot's
 *    persisted flag). We defer the bring-up wake meanwhile so the robot
 *    stays asleep for a clean wizard entrance.
 *  - `show`   : mount the wizard; it owns the first `wakeUp()`.
 *  - `done`   : skip / finished - wake the robot normally, never mount.
 */
type WizardGate = 'pending' | 'show' | 'done';

/**
 * Inner component split from the export so we can call
 * `useRobotSession()` only AFTER we've validated `robotId` is non-
 * null. React doesn't allow conditional hook calls; nesting the
 * hook into a separate component is the canonical way to keep the
 * "no peer id" early-return path hook-free.
 */
function ConnectedSession({
  robotId,
  robotName,
  robotHardwareId,
  robotTransport,
  token,
  username,
  onBack,
}: ConnectedSessionProps) {
  const orbRef = useRef<HTMLButtonElement | null>(null);

  // First wake-up wizard gate. The robot persists a "completed" flag, so the
  // wizard only ever shows once per robot (until reset) - we don't re-run it
  // on every connection. In dev, `FORCE_FIRST_WAKE_UP_IN_DEV` overrides that
  // and shows it every time so we can iterate.
  //
  // Seed:
  //  - wizard disabled          → `done` (never mount, wake on connect).
  //  - dev force                → `show` (mount every connection).
  //  - otherwise                → `pending` (resolve from the robot's flag
  //                               once we're live, see the effect below).
  //
  // Declared BEFORE `useRobotSession` so the engine's bring-up gate can read
  // it: while `pending`/`show` we defer the initial wake so the wizard's
  // motor step owns the first `wakeUp()`; on `done` we wake on connect.
  const forceWizard =
    import.meta.env.DEV && FORCE_FIRST_WAKE_UP_IN_DEV && FIRST_WAKE_UP_WIZARD_ENABLED;
  const [wizardGate, setWizardGate] = useState<WizardGate>(() => {
    if (!FIRST_WAKE_UP_WIZARD_ENABLED) return 'done';
    return forceWizard ? 'show' : 'pending';
  });

  // True while the on-connect wake-up animation is playing (wizard skipped):
  // greys out the End-session button so the user can't tear the session down
  // mid-wake. Cleared when `wakeUp()` resolves (motion done) or times out.
  const [waking, setWaking] = useState(false);

  const session = useRobotSession({
    robotId,
    robotHardwareId,
    robotName,
    token,
    audioLevelsTargetRef: orbRef,
    shouldDeferInitialWakeUp: () => wizardGate !== 'done',
  });

  // Latest published daemon version (GitHub). Fail-open: `null` until it
  // resolves / when offline, which keeps `DaemonUpdateGate` dormant and
  // `daemonOutdated` false.
  const latestDaemonVersion = useLatestDaemonVersion();

  // Same verdict the mandatory update gate renders on: is the connected
  // daemon behind the latest public release? Used below to hold the wizard
  // gate closed until an outdated daemon has been updated. Unknown versions
  // (offline / pre-update) read as not-outdated (fail-open).
  const daemonOutdated = isDaemonOutdated(session.daemonVersion, latestDaemonVersion);

  // Resolve the gate once the session is live: query the robot's persisted
  // first-wake-up flag and either show the wizard or skip it. On skip we
  // wake the robot ourselves, since we deferred the bring-up wake while the
  // flag was still unknown. Fail-open: an old daemon / closed channel
  // (`null`) skips the wizard. Dev-force / disabled short-circuit the seed
  // above, so this only runs for the real production gating.
  useEffect(() => {
    if (wizardGate !== 'pending') return;
    if (session.phase !== 'live') return;
    // Wait out the blocking daemon-update gate first. An outdated daemon
    // predates `get_first_wake_up`, so querying it now would just time out
    // (fail-open null) and we'd wrongly skip the wizard + wake the robot
    // before the user even updates. Once they update and the session
    // reacquires, `session.daemonVersion` changes, `daemonOutdated` flips
    // false and this re-runs against a current daemon. Dev branch builds can
    // read "outdated" vs the public release yet still support the command,
    // so we never block them (mirrors the update gate's own DEV bypass).
    if (!import.meta.env.DEV && daemonOutdated) return;
    let cancelled = false;
    void (async () => {
      const robot = session.getRobot();
      const completed = robot ? await robot.getFirstWakeUp() : null;
      if (cancelled) return;
      if (completed === false) {
        setWizardGate('show');
      } else {
        setWizardGate('done');
        if (robot) {
          // Grey out End-session for the duration of the wake animation.
          // Bounded by timeoutMs so a missed motion-done edge can't trap it.
          // No `cancelled` guard: setWizardGate('done') above re-runs this effect first.
          setWaking(true);
          void robot
            .wakeUp({ timeoutMs: 8000 })
            .catch(() => {})
            .finally(() => setWaking(false));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wizardGate, session, daemonOutdated]);

  // Optimistic display name. `robotName` comes from the central listing we
  // booted the session from, which is fixed for the session's lifetime. The
  // daemon applies a rename live (status + central relay + mDNS, no restart),
  // but our in-memory listing won't refresh on its own - so we override the
  // name locally the moment a rename lands, so the topbar identity + settings
  // reflect it immediately instead of only on the next app launch.
  const [displayName, setDisplayName] = useState(robotName);
  const handleRenameRobot = useCallback(
    async (name: string): Promise<string | null> => {
      const robot = session.getRobot();
      if (!robot) return null;
      const saved = await robot.setRobotName(name);
      if (saved) setDisplayName(saved);
      return saved;
    },
    [session],
  );

  // The wizard will run: warm the robot's HF cache for the onboarding moves
  // dataset now, so the motor step's `wake-mini-up` (first move played,
  // ~2 steps away) hits a local cache instead of blocking on a download.
  // The daemon deliberately no longer preloads app-specific datasets at
  // startup - this is the app-side half of that contract. Completion is
  // TRACKED (not fire-and-forget): the wizard holds its start action on
  // `movesReady` so the first emote never races a cold-cache download.
  // Fail-open on error/timeout - a failed/absent preload only costs latency
  // (`play_recorded_move` downloads on demand). Ref-guarded because the
  // session handle is a fresh object every render.
  const preloadedOnboardingRef = useRef(false);
  const [onboardingMovesReady, setOnboardingMovesReady] = useState(false);
  useEffect(() => {
    if (preloadedOnboardingRef.current) return;
    if (wizardGate !== 'show' || session.phase !== 'live') return;
    const robot = session.getRobot();
    if (!robot) return;
    preloadedOnboardingRef.current = true;
    if (robot.preloadDatasetAndWait) {
      void robot
        .preloadDatasetAndWait(ONBOARDING_MOVES_DATASET, {
          timeoutMs: ONBOARDING_PRELOAD_TIMEOUT_MS,
        })
        // Rejections (channel closed, session teardown) and error/timeout
        // resolutions all unlock the wizard the same way: lazy download
        // still works at play time, just slower.
        .catch(() => null)
        .then(() => setOnboardingMovesReady(true));
    } else if (robot.preloadDataset) {
      // Older SDK without the awaited variant: fire-and-forget like before,
      // and don't hold the wizard on a signal that will never come.
      robot.preloadDataset(ONBOARDING_MOVES_DATASET);
      setOnboardingMovesReady(true);
    } else {
      setOnboardingMovesReady(true);
    }
  }, [wizardGate, session]);

  // Wizard finished: close the gate and persist the completion flag on the
  // robot so it never shows again (dev-force ignores the flag on the next
  // run, but we still store it - production respects it). Fire-and-forget:
  // a failed write must not trap the user in the wizard.
  const handleWizardFinish = useCallback(() => {
    setWizardGate('done');
    void session.getRobot()?.setFirstWakeUp(true);
  }, [session]);

  // Remember which personality this robot is wearing, keyed by its
  // stable hardware id, so the discovery list ("Your Reachies") can
  // show each robot with the face it was last paired with rather than
  // the generic Reachy silhouette. Records the current persona on mount
  // and on every mid-session switch. No-op when the daemon doesn't
  // expose a hardware id (older daemons / no Reachy attached).
  const activePersona = useActivePersonality();
  // Prefer the stable hardware id; fall back to the routable peer id
  // when the daemon doesn't expose one (older daemons / no Reachy
  // attached) so the memory still works within a session round-trip.
  const robotMemoryKey = robotHardwareId ?? robotId;
  useEffect(() => {
    rememberRobotPersona(robotMemoryKey, activePersona.id);
  }, [robotMemoryKey, activePersona.id]);

  // Play a short choreography on the robot whenever the user switches
  // personality. Gated on a live transport with NO conversation running
  // (persona switching only happens from the idle picker), so the move
  // never fights the conversation's live motion stack.
  useChangePersonaAnimation({
    getRobot: session.getRobot,
    isLive: session.connectionState === 'live',
    isIdle: session.conversationState === 'idle',
  });

  const [tab, setTab] = useState<Tab>('conv');
  // Tab to return to when the immersive telepresence view is exited.
  const lastNonTeleTabRef = useRef<Exclude<Tab, 'tele'>>('conv');
  useEffect(() => {
    if (tab !== 'tele') lastNonTeleTabRef.current = tab;
  }, [tab]);
  // Overboard manual (Bluetooth) mode, toggled from the telepresence
  // settings. Releases the robot session entirely (see the handoff effect
  // below); only meaningful while the telepresence tab is up.
  const [overboardManual, setOverboardManual] = useState(false);
  useEffect(() => {
    if (tab !== 'tele') setOverboardManual(false);
  }, [tab]);
  // True while the conversation tab has a persona authoring form open. The
  // bottom tab bar is pulled for the duration - see the `BottomNavigation`
  // below for why.
  const [authoringPersona, setAuthoringPersona] = useState(false);
  // The conv tab is kept mounted (just `display: none`d) so its orb
  // audio refs survive a tab switch, which makes switching TO it
  // instant. The Apps tab used to be torn down and remounted on every
  // visit - its heavy first render (catalog fetch + carousels + rails)
  // blocked the click, so switching to Apps felt laggy while conv did
  // not. Mount it lazily on first visit, then KEEP it alive (CSS
  // toggle like conv) so every later switch is instant too.
  const [appsMounted, setAppsMounted] = useState(false);
  useEffect(() => {
    if (tab === 'apps') setAppsMounted(true);
  }, [tab]);

  // Tab-switch spinner. Every conv <-> apps switch shows a centered
  // spinner over the content column for a MINIMUM of 250 ms so the
  // transition reads as a deliberate beat rather than an instant
  // cut. It naturally lasts longer when needed: the target tab's own
  // loading state (e.g. `AppsTabView`'s first-paint / fetch spinner)
  // takes over seamlessly once this minimum cover lifts, since both
  // render the same centered spinner on the same `background.default`
  // surface. Driven through `handleTabChange` (not raw `setTab`) so
  // the cover only fires on a real switch, never on a no-op re-tap.
  const [tabSpinner, setTabSpinner] = useState(false);
  const tabSpinnerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (tabSpinnerTimerRef.current) clearTimeout(tabSpinnerTimerRef.current);
    },
    []
  );
  // Imperative handle into the Apps tab so the shell can pop its
  // sub-navigation (store / drill-down) back to the launcher.
  const appsViewRef = useRef<AppsTabViewHandle | null>(null);
  const handleTabChange = (value: Tab): void => {
    if (leaving) return;
    if (value === tab) {
      // Re-tap on the active Apps tab = pop back to "Your apps"
      // (standard mobile tab-bar gesture). No spinner: it's an
      // in-tab reset, not a tab switch.
      if (value === 'apps') appsViewRef.current?.popToRoot();
      return;
    }
    if (tabSpinnerTimerRef.current) clearTimeout(tabSpinnerTimerRef.current);
    setTabSpinner(true);
    setTab(value);
    tabSpinnerTimerRef.current = setTimeout(() => setTabSpinner(false), 250);
  };
  /**
   * App selected from the catalog; non-null while the iframe overlay
   * is being prepared (`releasing`), shown (`ready`), or closing
   * (`reacquiring`). The handoff lifecycle is managed via the
   * effects below so the iframe's mount lines up with the WebRTC
   * release.
   */
  const [openedApp, setOpenedApp] = useState<AppEntry | null>(null);
  // Robot Settings overlay, toggled from the topbar cog. This is now the
  // single topbar sheet: it leads with robot-level Audio + the
  // conversation options, and drills into "About & diagnostics" (the old
  // info panel: hardware id, connection, software, account, live logs)
  // via `settingsView`. `position: fixed` under the topbar; covers the
  // body + bottom nav, so it stays put until dismissed. Mounted /
  // unmounted via the flag (the daemon log buffer is gated inside
  // `useDaemonLogs` on the engine being live, and the content is cheap
  // to remount).
  const [settingsOpen, setSettingsOpen] = useState(false);
  /**
   * Which Settings page is showing: the root list, or the drilled-in
   * "About & diagnostics" sub-page (the old `RobotInfoPanel`). Reset to
   * `'root'` every time the overlay is toggled so it always opens at the
   * top level and a fresh open never lands deep in diagnostics.
   */
  const [settingsView, setSettingsView] = useState<'root' | 'about'>('root');

  // Daemon version is fetched (with retry-on-null) by the
  // `<DaemonStateProvider>` further down and read by the info sheet
  // (`<RobotInfoSheet>`) and the audio cards via `useDaemonState()`.
  // Centralising it there means the same value is shared across
  // every consumer without any component having to fetch it locally.

  // Power-off / back: drives `session.tearDown()` (gotoSleep + motors
  // disabled + stopSession + disconnect) before navigating away. The
  // screen renders the leaving view in the meantime.
  const [leaving, setLeaving] = useState(false);
  const leavingTriggeredRef = useRef(false);
  useEffect(() => {
    if (!leaving) return;
    let cancelled = false;
    void (async () => {
      await session.tearDown();
      if (cancelled) return;
      onBack();
    })();
    return () => {
      cancelled = true;
    };
  }, [leaving, onBack, session]);

  const handleLeave = (): void => {
    if (leavingTriggeredRef.current) return;
    leavingTriggeredRef.current = true;
    setLeaving(true);
  };

  // Handoff lifecycle for the apps iframe.
  //
  //   user taps app card  →  setOpenedApp(app)
  //                         ↓
  //                    session.releaseForHandoff()
  //                         ↓
  //                    iframe overlay mounts
  //                         ↓
  //                    user closes iframe  →  setOpenedApp(null)
  //                         ↓
  //                    session.reacquire()
  //                         ↓
  //                    conversation tab can resume normally
  //
  // The release+reacquire calls go through the engine's lifecycle
  // queue, so a fast user (open / close before the previous step
  // resolves) gets queued operations instead of races.
  const previousOpenedAppRef = useRef<AppEntry | null>(null);
  useEffect(() => {
    const previous = previousOpenedAppRef.current;
    previousOpenedAppRef.current = openedApp;
    if (previous === null && openedApp !== null) {
      console.log(`[shell-webrtc] iframe-open: releasing session for app ${openedApp.id}`);
      // Just opened an app: release the session so the iframe can
      // dial in. The overlay itself shows a "Releasing…" hint while
      // the promise is in flight; we don't await here so React
      // commits the iframe mount immediately and the overlay's own
      // effects can drive its phase indicator.
      void session.releaseForHandoff();
    } else if (previous !== null && openedApp === null && !leaving) {
      console.log(`[shell-webrtc] iframe-close: reacquiring session after app ${previous.id}`);
      // Just closed an app: bring the session back up so the
      // conversation tab is usable again. We skip this when
      // `leaving` is true because tearDown is already in flight
      // and reacquire would race with it.
      void session.reacquire();
    }
  }, [openedApp, leaving, session]);

  // Same release / reacquire handoff for overboard manual mode: the
  // phone drives the base over BLE, so the WebRTC slot (video, audio,
  // head control) is released for the duration and brought back on exit.
  const previousManualRef = useRef(false);
  useEffect(() => {
    const previous = previousManualRef.current;
    previousManualRef.current = overboardManual;
    if (!previous && overboardManual) {
      console.log('[shell-webrtc] overboard manual mode: releasing session');
      void session.releaseForHandoff();
    } else if (previous && !overboardManual && !leaving) {
      console.log('[shell-webrtc] overboard manual mode off: reacquiring session');
      void session.reacquire();
    }
  }, [overboardManual, leaving, session]);

  // Tab-switch lifecycle for the conversation parts.
  //
  // Leaving the conversation tab stops the HF realtime pipeline,
  // motion controllers and audio analysers. The robot stays awake
  // (gravity-comp on the head/antennas, motors enabled, WebRTC up,
  // SSE alive) so re-entering the tab is instant - the user just
  // sees the orb in `ready`, taps once, and they're back in a fresh
  // conversation.
  //
  // Why stop on tab switch (not on iframe-open): going to the apps
  // surface signals "I'm browsing, not talking". Having the AI
  // listen / speak in the background while the user picks an app
  // wastes API tokens and is confusing audio-wise (the robot still
  // narrates while the apps tab is shown). Stopping here is the
  // minimal-surprise default.
  //
  // `stopConversation` is idempotent (no-op if no conversation is
  // running), so this effect is safe to fire on every non-`conv`
  // render including initial mounts and rapid tab oscillations.
  const { stopConversation } = session;
  useEffect(() => {
    if (tab === 'conv') return;
    void stopConversation();
  }, [tab, stopConversation]);

  const isError = session.phase === 'error' && !leaving;
  // Connecting overlay: only fires for the INITIAL bring-up. After
  // `hasReachedReady` flips, subsequent transient states (a
  // re-acquire after handoff, the conversation re-starting) keep
  // the orb on screen with its own internal spinner instead of the
  // full-screen overlay.
  const showConnectingOverlay =
    !leaving && !isError && !session.hasReachedReady && session.phase === 'bringing-up';

  // Recovering overlay: an in-place bring-up retry after a
  // transport-level fatal on an established session (see the
  // auto-recover effect below). Compact view, full-screen cover -
  // the full connecting pipeline stays reserved for the initial
  // bring-up.
  //
  // Deliberately NOT shown for the `reacquiring` phase: that one fires
  // on every iframe-app close (a planned, short-lived handoff, not a
  // connection loss), where a full-screen "Reconnecting" reads as a
  // failure. During reacquire the normal UI stays up and the identity
  // chip's pulsing "Reconnecting" badge is the only indicator.
  const showRecoveringOverlay = !leaving && session.phase === 'recovering';

  // One-shot in-place recovery. When a session that had already
  // reached ready dies (SDK re-dial gave up, data-channel fatal,
  // failed reacquire), retry the bring-up under the compact overlay
  // INSTEAD of dumping the user straight onto the fatal error view -
  // whose only exit remounts everything and replays the full
  // connecting pipeline. One attempt per incident: a second
  // consecutive fatal falls through to `SessionErrorView` as before.
  // The latch re-arms once the session is healthy again, so the NEXT
  // incident gets its own automatic attempt.
  const autoRecoverTriedRef = useRef(false);
  useEffect(() => {
    if (session.phase === 'live') {
      autoRecoverTriedRef.current = false;
      return;
    }
    if (session.phase !== 'error' || leaving) return;
    // Initial bring-up failures keep the full error UX: there is no
    // "known good" state to restore, the pipeline narrative is honest.
    if (!session.hasReachedReady) return;
    // While an iframe app owns the slot, the close-path reacquire is
    // the recovery mechanism - don't fight it from underneath.
    if (openedApp !== null) return;
    // Manual overboard mode released the slot on purpose.
    if (overboardManual) return;
    if (autoRecoverTriedRef.current) return;
    autoRecoverTriedRef.current = true;
    console.log('[shell-webrtc] auto-recover: transport fatal after ready, retrying in place');
    void session.recover();
  }, [session, leaving, openedApp, overboardManual]);

  // Keep-screen-on rule. We only ask the OS to suppress the idle
  // timer while the user is engaged with the robot in a way that
  // can't tolerate a mid-flow screen lock. Three contexts qualify:
  //
  //   - **Active conversation**. The orb is `listening`,
  //     `user-speaking`, `processing` or `ai-speaking`: user and
  //     robot are mid-dialog, a screen lock would drop the WebRTC
  //     audio and break the turn.
  //   - **Open iframe app** (Marionette etc.). The conversation
  //     engine has released its session for handoff (`releaseFor
  //     Handoff`) so the engine-side wake lock is OFF here - we
  //     pick up the slack from the UI layer. This is the case the
  //     original bug report covered.
  //   - **Bring-up in flight**. `connecting` / `auto-selecting` /
  //     `starting`: the user is actively waiting on the loading
  //     view. Letting the screen sleep mid-handshake would force
  //     a fresh tap to wake the device, only to find a stalled
  //     session - irritating.
  //
  // Anything else (`ready` orb idle, `connected` without a
  // conversation, the error / leaving terminal states) lets the
  // system idle timer behave normally. The hook is refcounted at
  // the module level, so other screens can opt into the same lock
  // without coordination.
  const isConversing =
    session.conversationState === 'listening' ||
    session.conversationState === 'user-speaking' ||
    session.conversationState === 'processing' ||
    session.conversationState === 'ai-speaking';
  const isBringingUp =
    session.connectionState === 'connecting' ||
    session.connectionState === 'selecting' ||
    session.connectionState === 'starting';
  const isAppOpen = openedApp !== null;
  useKeepScreenOn(isConversing || isBringingUp || isAppOpen || tab === 'tele');

  return (
    /* `DaemonStateProvider` is the single source of truth for
       what the daemon currently reports (volumes, version, future
       motor mode, etc.). It mounts here so every tab body and the
       top toolbar share the same fetched values - no double
       round-trips, no race-on-null artefacts where one tab sees
       a stale `null` while another already fetched. The provider
       gates its own fetch lifecycle on `enabled`; we wire it to
       `session.hasReachedReady` so we only round-trip once the
       engine is past bring-up. */
    <DaemonStateProvider session={session} enabled={session.hasReachedReady}>
      <Stack
        sx={{
          height: '100%',
          width: '100%',
          px: 3,
          pb: 0,
          // No explicit bg: we inherit `background.default` (grey)
          // from the App root and let the cards inside (audio
          // controls, app cards) be the only WHITE surfaces. Same
          // pattern as `ScanScreen` and the rest of the app:
          // single grey canvas + white card islands, top + bottom
          // bars blend with the canvas (only divider lines
          // separate them).
        }}
      >
        {/* Top toolbar - full bleed, mirror of the BottomNavigation.
         *
         *   ┌─────────────────────────────────────────────────────────┐
         *   │  reachy-mini-foo  [Wi-Fi]                  [ⓘ]   [⏻]  │
         *   │  #abc12                                                  │
         *   └─────────────────────────────────────────────────────────┘
         *
         * Visual contract:
         *   - `mx: -3` cancels the outer column's `px: 3` so the bar
         *     spans edge-to-edge of the viewport, exactly like the
         *     `BottomNavigation` does at the other end of the screen.
         *   - The bar uses `background.default` (grey) - the same
         *     tone as the body. They blend visually; only the
         *     1 px bottom divider demarcates the bar from the
         *     content. Cards inside the body are
         *     `background.paper` (white) and pop as the only
         *     "interesting" surfaces. Same convention as
         *     `ScanScreen` and the rest of the app.
         *   - `pt = calc(env(safe-area-inset-top) + 12px)` lets the
         *     bar bg paint INTO the iOS notch while keeping the
         *     controls vertically padded. On platforms without an
         *     inset we just get the 12px fallback.
         *   - Internal `px: 3` matches the body's horizontal rhythm so
         *     the identity column and right-hand action buttons
         *     visually align with the body content edges.
         *
         * Identity (`IdentityChipBar`) takes the left flex column and
         * carries the everyday-grade identity: robot name + physical
         * transport chip (Wi-Fi / USB) + short hardware id.
         *
         * Right edge carries two icon buttons:
         *   - `[⚙]` opens the robot Settings sheet (Audio + the
         *     conversation options). The debug-grade signals (daemon
         *     version, live WebRTC kind + IP + bitrate, daemon log
         *     tail) that used to sit behind a dedicated `[ⓘ]` button
         *     now live one level deeper, behind the Settings sheet's
         *     "About & diagnostics" row (`<RobotInfoPanel>` as a
         *     drilled-in sub-page). While the sheet is open the cog
         *     glyph swaps to a cross (`✕`) so a second tap dismisses.
         *   - `[⏻]` powers the robot down (gotoSleep + motors
         *     disabled + stopSession + disconnect). Rightmost glyph
         *     by design: it's destructive, the user's thumb naturally
         *     lands on the screen edge, and the position makes a
         *     mis-tap on the adjacent info button much less likely
         *     than the other way around.
         *
         * We dropped the `@username` chip a while back: the user is by
         * definition signed in here, the redundant pill was just
         * noise.
         */}
        <Stack
          direction="row"
          spacing={1.5}
          sx={{
            alignItems: 'center',
            flexShrink: 0,
            // True full-bleed: cancel the column's `px: 3` on BOTH
            // sides so the bottom divider reaches the screen edges
            // (an asymmetric `ml: -2` used to leave an 8px unbordered
            // strip on the left). `pl: 3` restores the 24px content
            // inset; `pr: 2` keeps the action cluster's tighter right
            // rhythm (the power button overshoots via `edge="end"`).
            mx: -3,
            pl: 3,
            pr: 2,
            pb: 1.5,
            pt: 'calc(var(--inset-top, env(safe-area-inset-top, 0px)) + 10px)',
            minHeight: 68,
            bgcolor: 'background.default',
            borderBottom: t => `1px solid ${t.palette.divider}`,
            // Sit above the personality band below (which lifts itself to
            // zIndex 1 so its avatar disc can spill over the body). The
            // avatar artwork pokes up past the band's top edge; this opaque
            // bar + its divider must stay on top so those antennas tuck
            // behind it instead of breaking the topbar's bottom border.
            position: 'relative',
            zIndex: 2,
          }}
        >
          <IdentityChipBar
            robotName={displayName}
            transport={robotTransport}
            linkKind={session.webrtcTransport?.kind ?? null}
            linkRttMs={session.webrtcTransport?.rttMs ?? null}
            sessionPhase={session.phase}
          />
          {/* Right-hand action cluster. `spacing={0.25}` keeps the two
              buttons visually grouped (they're both "session-level
              controls") while remaining distinct tap targets - MUI's
              default `IconButton` has its own internal padding so
              they don't visually touch.
              No `mr` on the wrapper: the rightmost button uses MUI's
              canonical `edge="end"` prop instead (see below). That
              keeps the wrapper's own bounds inside `px: 3` so the
              "info" button still aligns naturally on its inner edge,
              while only the trailing power button is allowed to
              visually overshoot toward the screen edge. */}
          <Stack
            direction="row"
            spacing={0.25}
            sx={{
              alignItems: 'center',
              flexShrink: 0,
            }}
          >
            {/* Settings cog. Sits to the LEFT of the info button and
                behaves identically (same slot, glyph swaps to `✕` when
                open, tap-again dismisses). Opens the robot Settings panel
                (robot-level Audio first, then the conversation options).
                Shown on every tab (like the info button) so the robot
                settings are reachable from Conversation AND Apps. Opening
                it closes the info panel (the two sheets are mutually
                exclusive). */}
            <IconButton
              aria-label={settingsOpen ? 'Close settings' : 'Settings'}
              onClick={() => {
                // Always land on the root Settings page when (re)opening;
                // resetting on close too keeps the next open predictable.
                setSettingsView('root');
                setSettingsOpen(open => !open);
              }}
              color="primary"
              sx={{ flexShrink: 0 }}
            >
              {settingsOpen ? (
                <CloseIcon sx={{ fontSize: 24 }} />
              ) : (
                <SettingsOutlinedIcon sx={{ fontSize: 24 }} />
              )}
            </IconButton>
            {/* `edge="end"` is the MUI-canonical way to neutralise the
                IconButton's intrinsic right padding so the glyph
                optically aligns with content edges above/below
                rather than sitting with a double-padding gap
                (cf. https://mui.com/material-ui/api/icon-button/
                #icon-button-prop-edge). Applies `marginRight: -12`
                to the button itself, pulling its hitbox closer to
                the screen edge while preserving the 40 × 40 tap
                target and its circular ripple. Only the trailing
                power button gets this treatment - the leading info
                button keeps its natural inner-edge spacing so the
                pair still reads as a tight cluster. */}
            <IconButton
              aria-label="End session"
              onClick={handleLeave}
              color="primary"
              disabled={leaving || waking}
              // Pull the glyph toward the screen edge with a negative
              // MARGIN (not `edge="end"`, which uses -12px, nor a padding
              // override which would oval the hover). `mr: -1` (-8px)
              // matches the personality band's chevron below exactly
              // (same 40x40 button, same -8px), so the two stay aligned on
              // the same vertical axis. Margin keeps the button square, so
              // the hover/ripple background stays a perfect circle.
              sx={{ flexShrink: 0 }}
            >
              <PowerSettingsNewIcon sx={{ fontSize: 24 }} />
            </IconButton>
          </Stack>
        </Stack>

        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            width: '100%',
            maxWidth: LAYOUT.contentMaxWidth,
            mx: 'auto',
            // No `pt` here on purpose: each tab's body owns its own
            // top spacing. The conv tab's persona sub-header needs
            // to sit FLUSH against the top toolbar's bottom divider
            // so the two bands read as one continuous chrome strip;
            // any `pt` here would push it down with a stray gap.
            // The apps tab already applies its own `pt: 1` inside
            // its content stack (see AppsTabView), so the visual
            // rhythm stays the same for it.
            position: 'relative',
          }}
        >
          {/* Conversation tab. Mounted whenever the session is live;
              hidden via CSS (not unmounted) when the user is on
              the Apps tab so the orb's `<button>` keeps providing
              `orbRef` to the engine's audio level monitors.
              Layout:
                ┌──────────────────────────────────┐
                │                                  │
                │                                  │
                │            ORB                   │  ← centre, full
                │                                  │     vertical space
                │                                  │
                └──────────────────────────────────┘

              The Speaker / Microphone sliders now live in the
              conversation settings overlay (opened from the topbar
              cog, left of info) alongside the language / privacy
              options, so the orb gets the full body height to
              breathe on small phones. */}
          {!leaving && !isError && (
            <Box
              sx={{
                flex: 1,
                minHeight: 0,
                display: tab === 'conv' ? 'flex' : 'none',
                flexDirection: 'column',
                position: 'relative',
              }}
            >
              <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
                <ConversationPanel
                  session={session}
                  orbRef={orbRef}
                  active={tab === 'conv'}
                  onAuthoringChange={setAuthoringPersona}
                />
              </Box>
            </Box>
          )}

          {appsMounted && !leaving && (
            <Box
              sx={{
                flex: 1,
                minHeight: 0,
                display: tab === 'apps' ? 'flex' : 'none',
                flexDirection: 'column',
              }}
            >
              <AppsTabView ref={appsViewRef} onOpen={setOpenedApp} />
            </Box>
          )}

          {/* Tab-switch cover: a centered spinner shown for the
              minimum-duration beat after a conv <-> apps switch (see
              `handleTabChange`). Sits above both tab columns in the
              content area (below the header + bottom nav) so the new
              tab hydrates underneath it without flashing a half-built
              frame. Fades in/out for a smooth transition, and uses a
              high local `zIndex` (10) so it covers the Apps tab's
              sticky header bar (`zIndex: 3`), which would otherwise
              poke through the cover. */}
          <Fade in={tabSpinner} timeout={{ enter: 0, exit: 350 }} unmountOnExit>
            <Box
              sx={theme => ({
                position: 'absolute',
                // Full-bleed: the content column is `maxWidth`-capped
                // and centered, but the Apps tab escapes to `100vw`,
                // so an `inset: 0` cover would leave the tab content
                // peeking past its left/right edges. Span the whole
                // viewport width instead so the cover is flush.
                top: 0,
                bottom: 0,
                left: '50%',
                width: '100vw',
                transform: 'translateX(-50%)',
                zIndex: 10,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                bgcolor: theme.palette.background.default,
              })}
            >
              <CircularProgress size={32} sx={{ color: 'grey.300' }} />
            </Box>
          </Fade>
        </Box>

        <BottomNavigation
          value={tab}
          showLabels
          onChange={(_, value: Tab) => {
            handleTabChange(value);
          }}
          sx={theme => ({
            flexShrink: 0,
            mx: -3,
            // Pulled while a persona authoring form is up, for the same reason
            // the settings sheet covers this bar: a focused task with unsaved
            // work owns the whole screen. Leaving it would put "Apps" - a
            // half-the-screen-wide target - directly under the form's CTA, and
            // tapping it runs the conv panel's inactive-tab teardown, which
            // drops the form and every field the user typed with no
            // confirmation and no draft kept. The form carries its own way out
            // (the band's "✕", the hero's own close, the generation screen's
            // "Cancel"), so nobody gets trapped here.
            display: authoringPersona ? 'none' : 'flex',
            // BottomNavigation sizing on iPhone X+ : the bar must be
            // tall enough to host BOTH the comfortable 68 px tap row
            // AND the iOS home-indicator safe-area below it, AND each
            // action button's `paper` selected fill must reach the
            // physical bottom edge of the screen (Material convention:
            // the active tab visually anchors the column down to the
            // device edge, no orphan strip below).
            //
            // The previous attempt put the safe-area inset on the
            // parent's `padding-bottom`. That left the actions a clean
            // 68 px tall - good for centering - but the parent
            // padding's grey "shoe" appeared underneath the active
            // tab's paper fill, so the selected tab visibly stopped
            // ~34 px above the bottom edge on iPhone X+. The user's
            // expectation is the opposite: paper fill flush to the
            // bottom edge.
            //
            // Fix: stretch the actions to the FULL bar height (68 +
            // safe-area). The action is a flex child with `align-items:
            // stretch` (MUI default) so it naturally fills the bar's
            // cross-axis, including the home-indicator zone. With
            // symmetric inner padding the icon + label cluster centers
            // at the bar's true vertical middle - which on iPhone X+
            // sits a touch above the home-indicator pill, leaving ~30
            // px of breathing room below the label so the swipe-up
            // gesture stays unambiguous.
            //
            // On platforms with no safe area (macOS Tauri, Android,
            // desktop) `env()` resolves to 0 and the bar collapses
            // back to a flush 68 px - same rendering as before.
            height: 'auto',
            minHeight: 'calc(68px + var(--inset-bottom, env(safe-area-inset-bottom, 0px)))',
            // Android-only bottom padding to push the icon+label cluster
            // up out of the system-nav touch zone (3-button or gesture
            // bar). `--inset-bottom` is set by the host activity on
            // Android (see `MainActivity.kt`); on iOS it's undefined and
            // resolves to `0px`, preserving the original stretched-tab
            // layout where the active tab paper fill reaches the screen
            // edge under the home indicator. The "grey shoe" the
            // stretched-layout was designed to avoid never shows on
            // Android because the system-nav strip itself covers that
            // zone — purely a platform-asymmetric problem.
            paddingBottom: 'var(--inset-bottom, 0px)',
            borderTop: `1px solid ${theme.palette.divider}`,
            bgcolor: 'background.default',
            '& .MuiBottomNavigationAction-root': {
              minWidth: 0,
              // MUI defaults each action to `maxWidth: 168px`, which on
              // wider viewports (Tauri desktop window, large phones in
              // landscape) caps the tabs and leaves an empty grey
              // gutter on either side of the cluster. We want each
              // action to take exactly `1/N` of the bar - the divider
              // lines between siblings need to span the full bar
              // width, and the active tab's paper fill should reach
              // edge-to-edge of its slot. Unsetting `maxWidth` lets
              // the parent's `display: flex` (BottomNavigation root)
              // distribute the bar evenly across actions on every
              // viewport size.
              maxWidth: 'none',
              flex: 1,
              // Symmetric inner padding so the icon + label cluster is
              // truly centered in the action's full visual height
              // (68 + safe-area). The cluster ends up vertically
              // centered between the top divider and the device's
              // bottom edge, with the safe-area zone acting as
              // breathing room below the label rather than as dead
              // space outside the action.
              paddingTop: 0.75,
              paddingBottom: 0.75,
              gap: 0.5,
              backgroundColor: 'transparent',
              // Icon glyph in primary in BOTH states (MUI's default is
              // text.secondary when inactive): both tabs read as equally
              // "alive" actions. Active-tab identification falls to the
              // paper fill below + the label weight bump - the colour is
              // no longer part of that contract. The labels keep their
              // own forced text.secondary, so this only tints the icons.
              color: theme.palette.primary.main,
              transition: theme.transitions.create(['background-color', 'box-shadow'], {
                duration: 180,
                easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
              }),
              // Selected state: the whole action gets a soft primary
              // wash. With both tabs fully primary-tinted (icon +
              // label), colour alone can't identify the active tab, so
              // the tinted fill carries it - the full-slot version of
              // the M3 indicator pill. Alpha-based so it composes over
              // the bar's `background.default` in both light and dark
              // modes.
              '&.Mui-selected': {
                backgroundColor: alpha(theme.palette.primary.main, 0.08),
              },
            },
            // Light vertical divider between adjacent actions.
            // Painted via `inset box-shadow` rather than `borderRight`
            // so it doesn't add 1 px to the action's flex basis (each
            // action stays exactly 1/N of the bar's width). Applied
            // to every action except the last so the right edge of
            // the bar stays clean.
            '& .MuiBottomNavigationAction-root:not(:last-of-type)': {
              boxShadow: `inset -1px 0 0 0 ${theme.palette.divider}`,
            },
            // Label colour: muted on the INACTIVE tab so the active
            // one (primary + paper fill + weight bump) is instantly
            // readable at a glance.
            '& .MuiBottomNavigationAction-label': {
              fontSize: TYPO.xs,
              fontWeight: FONT_WEIGHT.medium,
              color: `${theme.palette.text.secondary} !important`,
            },
            // Selected = primary, heavier weight. We pin the size so
            // the bar doesn't twitch (MUI defaults bump the font
            // size on selection).
            '& .MuiBottomNavigationAction-label.Mui-selected': {
              fontSize: TYPO.xs,
              fontWeight: FONT_WEIGHT.semibold,
              color: `${theme.palette.primary.main} !important`,
            },
            // Sizing applies to both MUI icons (`MuiSvgIcon-root`)
            // and native `<svg>` elements - the latter is what
            // `vite-plugin-svgr` produces for our custom SVG icons
            // (e.g. `RobotIcon`). Using `font-size` over a hard
            // `width/height` keeps both kinds responsive: the SVG
            // components are configured (`svgrOptions.icon: true`
            // in vite.config.ts) to render at `1em × 1em`, so the
            // parent's font-size drives their rendered size.
            '& .MuiSvgIcon-root, & .MuiBottomNavigationAction-root > svg': {
              fontSize: 26,
            },
          })}
        >
          {/* Conversation = "tap to talk to Reachy". A stroke-only
              outlined speech bubble (`ChatBubbleIcon`) keyed to the
              same 1.8px outline treatment as `AppsIcon`, signalling
              the conversational nature of the tab. */}
          <BottomNavigationAction value="conv" label="Conversation" icon={<ChatBubbleIcon />} />
          {/* Bespoke `AppsIcon` (4 hollow rounded squares in a 2×2
              grid) so the glyph matches the visual rhythm of
              `MicIcon` - same `1.8 px` stroke weight, same
              outline-only treatment, same 24×24 viewBox. */}
          <BottomNavigationAction value="apps" label="Apps" icon={<AppsIcon />} />
          {/* Telepresence: live camera + head / wheels joysticks, native
              counterpart of the telepresence Space (no iframe handoff). */}
          <BottomNavigationAction value="tele" label="Telepresence" icon={<VideocamOutlinedIcon />} />
        </BottomNavigation>

        {/* Settings overlay. The single topbar sheet, pinned BELOW the
            session topbar so the topbar's identity chips + the cog's
            `✕` (tap-again-to-dismiss) stay visible. Covers the body +
            bottom nav, so tab switching is suppressed while it's up.
            Two pages swap in place:
              - `'root'`  : the `<ConversationSettingsPanel>` (Audio +
                conversation options + the "About & diagnostics" row).
              - `'about'` : the `<RobotInfoPanel>` (hardware id,
                connection, software, account, live logs), reached by
                drilling in from the root and dismissed back to it via
                the panel's own back header.
            Geometry:
              - `top: max(68px, safe-area + 62px)` is the exact total
                height of the session topbar (pt 10 + ~40 content + pb
                12 = 62 above the inset):
                  desktop  : max(68, 0+62)  = 68 ✓
                  iPhone X : max(68, 47+62) = 109 ✓
                The `max()` accounts for the topbar's `minHeight: 68`
                floor on platforms without a notch.
              - zIndex 1200 stays above body content / bottom nav but
                BELOW the AppIframeOverlay / FullScreenTransition layer
                (1300) so a connecting / leaving / iframe-open event
                still takes precedence over a stale sheet.
            `display: flex` lets either panel's `flex: 1` column fill
            the overlay. */}
        {settingsOpen && (
          <Box
            sx={{
              position: 'fixed',
              top: `max(68px, calc(${LAYOUT.safeAreaTop} + 62px))`,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 1200,
              display: 'flex',
              flexDirection: 'column',
              bgcolor: 'background.default',
            }}
          >
            {settingsView === 'about' ? (
              <RobotInfoPanel
                onBack={() => setSettingsView('root')}
                onClose={() => {
                  setSettingsView('root');
                  setSettingsOpen(false);
                }}
                hardwareId={robotHardwareId}
                fallbackId={robotId}
                username={username}
                session={session}
                isLive={session.hasReachedReady}
              />
            ) : (
              <ConversationSettingsPanel
                audioReady={session.hasReachedReady}
                onOpenAbout={() => setSettingsView('about')}
                conversationLive={session.conversationState !== 'idle'}
                robotName={displayName}
                renameRobot={handleRenameRobot}
                signOutRobot={() => session.getRobot()?.signOut() ?? Promise.resolve(null)}
                onSignedOutRobot={() => {
                  setSettingsOpen(false);
                  handleLeave();
                }}
              />
            )}
          </Box>
        )}

        {/* Telepresence tab: immersive full-screen layer (zIndex 1250)
            covering the topbar + tab bar, exited via its own back
            button. Mounted only while the tab is active so its motion,
            audio and overboard loops live exactly as long as the view. */}
        {/* Stays mounted while `leaving` (the leaving cover sits above it)
            so it sees `allowMotion` drop and never glides the head while
            the teardown puts the robot to sleep. */}
        {tab === 'tele' && !isError && (
          <TelepresencePanel
            session={session}
            manualMode={overboardManual}
            onManualModeChange={setOverboardManual}
            onExit={() => handleTabChange(lastNonTeleTabRef.current)}
            allowMotion={!leaving && !waking && wizardGate !== 'show'}
          />
        )}

        {openedApp && (
          <AppIframeOverlay
            app={openedApp}
            hfToken={token}
            hfUsername={username}
            robotPeerId={robotId}
            robotHardwareId={robotHardwareId}
            robotName={displayName}
            transport={robotTransport}
            sessionPhase={session.phase}
            onClose={() => setOpenedApp(null)}
          />
        )}

        {/* Full-screen connecting transition: covers EVERYTHING (header,
            identity chips, body, bottom nav) so the user sees only the
            spinning indicator until the robot is physically online. The
            conversation panel keeps rendering underneath so its
            `orbRef` is populated by the time the engine's audio level
            monitors spin up. */}
        {showConnectingOverlay && (
          <FullScreenTransition>
            <ConnectingView
              state={session.connectionState}
              connectionAttempt={session.connectionAttempt}
              bringUpPhase={session.bringUpPhase}
            />
          </FullScreenTransition>
        )}
        {/* Full-screen reconnect transition: covers EVERYTHING (top
            bar, body, bottom nav) while the session recovers in place
            after a transport fatal. Full-bleed on purpose: a partial
            overlay left interactive chrome (tabs, settings) around a
            session that can't serve any of it yet, which read as
            broken. The view itself stays compact (spinner + one line);
            the full connecting pipeline remains reserved for the
            initial bring-up. Iframe-handoff reacquires do NOT surface
            here (see `showRecoveringOverlay`). */}
        {showRecoveringOverlay && (
          <FullScreenTransition>
            <ReconnectingView />
          </FullScreenTransition>
        )}
        {/* Full-screen leaving transition: covers EVERYTHING while the
            engine is mid-teardown (gotoSleep + motors disabled +
            stopSession + disconnect). */}
        {leaving && (
          <FullScreenTransition>
            <LeavingView />
          </FullScreenTransition>
        )}
        {/* Full-screen error transition: when the engine reports a
            fatal state (connection lost, etc.), the error card must
            cover EVERYTHING - top bar, body, bottom nav. Rendering
            it inside the body column would scope it to whatever tab
            the user happened to be on when the engine died (e.g.
            showing the "connection lost" card *inside the apps
            list*, which reads as a contextual error rather than the
            critical session-level event it is). The overlay sits
            above all other surfaces and lets the user back out via
            its primary CTA. */}
        {isError && (
          <FullScreenTransition>
            <SessionErrorView
              message={session.errorMessage}
              onBack={handleLeave}
              // In-place retry, only when there was a working session to
              // restore (same gate as the auto-recover effect). Initial
              // bring-up failures keep Back as the single exit: with no
              // known-good state, "try again" would just replay the same
              // failure without new information.
              onRetry={
                session.hasReachedReady
                  ? () => {
                      void session.recover();
                    }
                  : undefined
              }
            />
          </FullScreenTransition>
        )}

        {/* Daemon update gate. Self-contained full-screen flow that
            takes over (zIndex 1400, above every transition above) when
            the connected robot's daemon is behind the latest release.
            Renders nothing while up to date / version unknown. */}
        {!leaving && (
          <DaemonUpdateGate
            session={session}
            latestVersion={latestDaemonVersion}
            onBackToRobots={handleLeave}
          />
        )}

        {/* First wake-up wizard. Shown once per robot: the gate resolves from
            the daemon's persisted `get_first_wake_up` flag (see the wizard-gate
            effect above), and `set_first_wake_up` is written on finish. Sits on
            top of the conversation UI but BELOW the daemon update gate (zIndex
            1380 vs 1400) so a mandatory update still wins. */}
        {/* AnimatePresence lets the wizard play its exit fade on finish so the
            conversation UI (already mounted behind it) cross-fades in instead
            of hard-cutting when `wakeUpDone` flips true. */}
        <AnimatePresence>
          {!leaving && session.phase === 'live' && wizardGate === 'show' && (
            <FirstWakeUpWizard
              key="first-wake-up"
              session={session}
              robotName={displayName}
              movesReady={onboardingMovesReady}
              onRename={handleRenameRobot}
              onFinish={handleWizardFinish}
            />
          )}
        </AnimatePresence>
      </Stack>
    </DaemonStateProvider>
  );
}

/**
 * Viewport-spanning transition cover. Uses the same layering as
 * `<AppIframeOverlay>` (`position: fixed`, `zIndex: 1300`, matching
 * MUI's modal layer) so it sits above the bottom navigation, the
 * header chrome, AND any open iframe overlay (the latter shouldn't
 * happen with our current state machine but the layering is safe).
 */
function FullScreenTransition({ children }: { children: React.ReactNode }) {
  return (
    <Box
      sx={theme => ({
        position: 'fixed',
        inset: 0,
        zIndex: 1300,
        display: 'flex',
        flexDirection: 'column',
        bgcolor: theme.palette.background.default,
      })}
    >
      {children}
    </Box>
  );
}

function NoPeerIdView({ robotName, onBack }: { robotName: string; onBack: () => void }) {
  return (
    <Stack
      sx={{
        height: '100%',
        width: '100%',
        px: 3,
        pt: LAYOUT.safeAreaTop,
        pb: 4,
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: 'center',
          mb: 2,
          minHeight: 40,
        }}
      >
        <IconButton aria-label="Back" onClick={onBack} edge="start">
          <ArrowBackIcon />
        </IconButton>
        <Typography
          sx={{
            flex: 1,
            fontSize: TYPO.lg,
            fontWeight: FONT_WEIGHT.semibold,
            textAlign: 'center',
            mr: 5,
          }}
        >
          {robotName}
        </Typography>
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <SessionErrorView
          headline="Robot has no peer id"
          message={
            "The robot listing on Hugging Face doesn't carry a routable identifier. " +
            'The robot may be offline or registering - try again in a moment.'
          }
          onBack={onBack}
        />
      </Box>
    </Stack>
  );
}
