/**
 * Bluetooth tools.
 *
 * A standalone maintenance hub reachable from the pre-connection Help
 * & Support overlay. It talks to a Reachy's daemon directly over BLE -
 * useful when the robot isn't on Wi-Fi yet, or to recover one that
 * won't come online for a normal WebRTC session.
 *
 *   intro → scan → pin → menu ─┬─ status
 *                              ├─ logs
 *                              ├─ update: check ─┬─ up to date
 *                              │                 └─ available → updating → done / failed
 *                              └─ recovery script: confirm → running → result / failed
 *
 * The BLE commands (`UPDATE_*`, `JOURNAL_*`, `CMD_<script>`, `PING`, see
 * `features/ble-provisioning/{update,tools}Protocol.ts`) all share ONE
 * command/response channel, so every command goes through `withBle` -
 * a promise chain that serialises the log poll loop and the user-driven
 * actions. The privileged ones (`UPDATE_*`, `CMD_*`) need a `PIN_` session;
 * we keep the PIN for the screen's lifetime and re-auth right before each
 * of them (`ensureAuthed`): it's a cheap sync command, it refreshes the
 * session TTL, and `CMD_` resets its auth flag after every run anyway.
 *
 * Grew out of the "update over Bluetooth" tool: same intro → scan → PIN
 * flow (reusing the setup wizard's device card + signal bars), with the
 * update check now one entry of a menu instead of the whole tool.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  List,
  ListItemButton,
  Stack,
  TextField,
  Typography,
  alpha,
} from '@mui/material';
import ArrowBackIosNewIcon from '@mui/icons-material/ArrowBackIosNew';
import ArticleOutlinedIcon from '@mui/icons-material/ArticleOutlined';
import BluetoothOutlinedIcon from '@mui/icons-material/BluetoothOutlined';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import RestartAltRoundedIcon from '@mui/icons-material/RestartAltRounded';
import SendRoundedIcon from '@mui/icons-material/SendRounded';
import SettingsBackupRestoreRoundedIcon from '@mui/icons-material/SettingsBackupRestoreRounded';
import SystemUpdateAltRoundedIcon from '@mui/icons-material/SystemUpdateAltRounded';
import TerminalRoundedIcon from '@mui/icons-material/TerminalRounded';
import WifiOffRoundedIcon from '@mui/icons-material/WifiOffRounded';
import WifiTetheringRoundedIcon from '@mui/icons-material/WifiTetheringRounded';

import {
  type BleDevice,
  type RobotNetInfo,
  type ScanController,
  connect as bleConnect,
  disconnect as bleDisconnect,
  reachyBySignal,
  startContinuousScan,
  watchConnection,
} from '@/features/ble/bleWifi';
import {
  authenticate,
  readIdentity,
  readNetworkInfo,
  wifiStatus,
  type WifiStatus,
} from '@/features/ble-provisioning/protocol';
import {
  isFullJournalChunk,
  journalRead,
  journalStart,
  journalStop,
  ping,
  readAvailableCommands,
  runScript,
} from '@/features/ble-provisioning/toolsProtocol';
import {
  updateCheck,
  updateInfo,
  updateStart,
  type UpdateInfo,
} from '@/features/ble-provisioning/updateProtocol';
import Section from '@/ui/design/Section';
import { LinkQualityBars, type LinkQuality } from '@/ui/design/LinkQualityBars';
import RobotAvatar from '@/ui/design/RobotAvatar';
import { FONT_WEIGHT, LAYOUT, RADIUS, STATUS, TYPO } from '@/ui/design/tokens';
import LogsView from './ble-tools/LogsView';

/** The PIN printed under the robot is the 5-char serial suffix. */
const PIN_LENGTH = 5;
const POLL_INTERVAL_MS = 3_000;
/** Stop polling after this many ticks (~10 min) as a safety net. */
const MAX_POLL_TICKS = 200;
const TERMINAL_STATUSES = new Set(['done', 'failed']);
/** `JOURNAL_READ` cadence while the logs view is up. */
const LOG_POLL_MS = 700;
/** Keep the newest ~24 KB of log text on screen (oldest lines dropped). */
const LOG_CAP_CHARS = 24 * 1024;
/** Shown when AVAILABLE_COMMANDS can't be read (old firmware / read error). */
const FALLBACK_SCRIPTS = ['RESTART_DAEMON', 'HOTSPOT'];

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

type Step =
  | 'intro'
  | 'scan'
  | 'pin'
  | 'menu'
  | 'status'
  | 'logs'
  | 'running'
  | 'result'
  | 'checking'
  | 'available'
  | 'uptodate'
  | 'updating'
  | 'done'
  | 'failed';

/** Steps where the BLE link is expected to be up (a drop is a failure). */
const LINKED_STEPS = new Set<Step>(['pin', 'menu', 'status', 'logs', 'checking', 'available', 'uptodate']);

/** What the status view collects, one command at a time. `undefined` = not fetched yet. */
interface RobotStatus {
  daemon?: 'online' | 'unreachable';
  net?: RobotNetInfo | null;
  wifi?: WifiStatus | null;
  hardwareId?: string | null;
}

/**
 * Friendly copy for the robot's `commands/<NAME>.sh` recovery scripts. Any
 * script not listed here still shows up, by its raw name. `destructive`
 * colours the confirm button; `after` is what the result view says once
 * the script is dispatched (they all restart the daemon, which drops BLE).
 */
interface ScriptMeta {
  label: string;
  caption: string;
  icon: React.ReactNode;
  confirm: string;
  after: string;
  destructive?: boolean;
}

const SCRIPT_META: Record<string, ScriptMeta> = {
  RESTART_DAEMON: {
    label: 'Restart the robot software',
    caption: 'Restarts the daemon, not the OS',
    icon: <RestartAltRoundedIcon fontSize="small" />,
    confirm: "The robot software will restart. Anything it's doing stops for a few seconds.",
    after: 'The robot software is restarting. It should be back within a minute.',
  },
  HOTSPOT: {
    label: 'Switch to hotspot mode',
    caption: "Leaves Wi-Fi and broadcasts the robot's own network",
    icon: <WifiTetheringRoundedIcon fontSize="small" />,
    confirm:
      'The robot will leave its Wi-Fi network and broadcast its own hotspot. You can put it back on Wi-Fi from the setup wizard.',
    after:
      "The robot is switching to hotspot mode and restarting its software. Its network should show up in your phone's Wi-Fi settings within a minute.",
  },
  WIFI_RESET: {
    label: 'Forget all Wi-Fi networks',
    caption: 'Robot falls back to hotspot mode',
    icon: <WifiOffRoundedIcon fontSize="small" />,
    confirm:
      "Every Wi-Fi network saved on the robot will be deleted and it will fall back to hotspot mode. You'll need the setup wizard to put it back online.",
    after:
      'The robot is forgetting its Wi-Fi networks and restarting in hotspot mode. Run the setup wizard to reconnect it.',
    destructive: true,
  },
  SOFTWARE_RESET: {
    label: 'Restore factory software',
    caption: 'Reinstalls the robot software from its recovery copy',
    icon: <SettingsBackupRestoreRoundedIcon fontSize="small" />,
    confirm:
      'The robot software will be replaced by its recovery copy and restarted. Only use this if the robot no longer starts properly after an update.',
    after: 'The robot is restoring its software and restarting. This can take a few minutes.',
    destructive: true,
  },
};

function scriptMeta(name: string): ScriptMeta {
  return (
    SCRIPT_META[name] ?? {
      label: name,
      caption: 'Run script on the robot',
      icon: <TerminalRoundedIcon fontSize="small" />,
      confirm: `Run ${name} on the robot?`,
      after: 'The robot is running the script.',
    }
  );
}

export default function BleToolsScreen({ onBack }: { onBack: () => void }) {
  const [step, setStep] = useState<Step>('intro');
  const [devices, setDevices] = useState<BleDevice[]>([]);
  const [scanning, setScanning] = useState(false);
  /** Address of the row being connected to (spinner + "Connecting to…"). */
  const [connectingTo, setConnectingTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pinError, setPinError] = useState(false);
  const [scripts, setScripts] = useState<string[]>(FALLBACK_SCRIPTS);
  const [pendingScript, setPendingScript] = useState<string | null>(null);
  const [resultScript, setResultScript] = useState<string | null>(null);
  const [linkLost, setLinkLost] = useState(false);
  const [status, setStatus] = useState<RobotStatus>({});
  const [statusLoading, setStatusLoading] = useState(false);
  const [logText, setLogText] = useState('');
  const [logsPaused, setLogsPaused] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [check, setCheck] = useState<{ current: string | null; latest: string | null }>({
    current: null,
    latest: null,
  });
  const [progress, setProgress] = useState<UpdateInfo | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const pinRef = useRef('');
  const linkUpRef = useRef(false);
  const jobIdRef = useRef<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const scanCtrlRef = useRef<ScanController | null>(null);
  // Generation counters: bumping one cancels the async loop/fetch it guards
  // (the loop checks it after every await and exits quietly).
  const journalGenRef = useRef(0);
  const journalPausedRef = useRef(false);
  const statusGenRef = useRef(0);
  const bleChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const stepRef = useRef<Step>(step);
  stepRef.current = step;

  /**
   * Serialise BLE traffic: the transport has one command/response channel,
   * and the log poll loop runs alongside user actions. Callers wrap a whole
   * sequence (auth + command) so nothing interleaves; never nest two.
   */
  const withBle = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const next = bleChainRef.current.then(fn, fn);
    bleChainRef.current = next.catch(() => undefined);
    return next;
  }, []);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    // Ticks already queued on the BLE chain bail out on a cleared job.
    jobIdRef.current = null;
  }, []);

  // Cancel the poll loop and queue the STOP right away, so a quick re-open
  // (Back, then "Daemon logs" again) enqueues START strictly after it. The
  // chain guarantees the STOP lands after any in-flight read. Skipped on a
  // dead link: the robot already stopped the stream on disconnect, and the
  // write would only hold the channel until it timed out.
  const stopJournal = useCallback(() => {
    journalGenRef.current++;
    if (linkUpRef.current) void withBle(journalStop);
  }, [withBle]);

  const stopScanLoop = useCallback(async () => {
    const ctrl = scanCtrlRef.current;
    scanCtrlRef.current = null;
    if (ctrl) await ctrl.stop();
  }, []);

  // Clean teardown: stop the poll + scan + journal loops and drop the BLE
  // link whenever the tool unmounts, regardless of which step we were on.
  useEffect(
    () => () => {
      stopPolling();
      linkUpRef.current = false;
      stopJournal();
      void scanCtrlRef.current?.stop();
      scanCtrlRef.current = null;
      void bleDisconnect();
    },
    [stopJournal, stopPolling]
  );

  // Watch the real link state. A drop while we're using the link is a hard
  // failure (the user moved away / robot powered off), except where it isn't
  // ours to judge: during the update itself the poll loop is authoritative,
  // and a recovery script's outcome is settled by `runScript` (it PINGs the
  // robot after the write), so a drop while running / right after a script
  // is reported as "sent, link gone" rather than as a failure.
  useEffect(() => {
    void watchConnection(connected => {
      linkUpRef.current = connected;
      if (connected) return;
      const s = stepRef.current;
      if (s === 'running' || s === 'result') {
        setLinkLost(true);
        setStep('result');
        return;
      }
      if (!LINKED_STEPS.has(s)) return;
      stopJournal();
      setPendingScript(null);
      setErrorText('The Bluetooth connection to your Reachy was lost.');
      setStep('failed');
    });
  }, [stopJournal]);

  // Continuous scan: keeps the nearby list live the whole time the scan step
  // is up (new robots appear, vanished ones drop out) instead of one frozen
  // sweep. Restarted on refocus and explicit rescan; stopped before connect.
  const runScan = useCallback(() => {
    setScanning(true);
    setDevices([]);
    void stopScanLoop();
    scanCtrlRef.current = startContinuousScan({
      onUpdate: live => setDevices(reachyBySignal(live)),
      // Empty-state copy already tells the user to power the robot on; an
      // error (e.g. permission) just stops the live indicator.
      onError: () => setScanning(false),
    });
  }, [stopScanLoop]);

  const handleStart = useCallback(() => {
    setStep('scan');
    runScan();
  }, [runScan]);

  // Re-scan when the app returns to the foreground while on the scan step:
  // mobile OSes kill an in-flight BLE scan when the app is backgrounded.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && stepRef.current === 'scan') {
        runScan();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [runScan]);

  const handlePick = useCallback(
    async (d: BleDevice) => {
      setBusy(true);
      setConnectingTo(d.address);
      try {
        // The radio can't scan and connect at once — stop the loop first.
        await stopScanLoop();
        setScanning(false);
        await bleConnect(d.address);
        linkUpRef.current = true;
        setLinkLost(false);
        setStep('pin');
      } catch (e) {
        setErrorText(`Could not connect: ${(e as Error).message}`);
        setStep('failed');
      } finally {
        setBusy(false);
        setConnectingTo(null);
      }
    },
    [stopScanLoop]
  );

  /**
   * Re-run `PIN_` with the remembered code right before a privileged
   * command. False (and back to the PIN step, flagged) when the robot
   * refuses it - wrong code or lockout. Must be called INSIDE `withBle`.
   */
  const ensureAuthed = useCallback(async (): Promise<boolean> => {
    const ok = await authenticate(pinRef.current);
    if (!ok) {
      setPinError(true);
      setStep('pin');
    }
    return ok;
  }, []);

  const enterMenu = useCallback(async () => {
    setStep('menu');
    // Best-effort: [] on an old firmware / read error → the two scripts
    // every robot ships with.
    // The robot lists its scripts in directory order; show the ones we know
    // in a sensible order (least → most drastic), unknown ones after.
    const names = await withBle(readAvailableCommands);
    const known = Object.keys(SCRIPT_META).filter(n => names.includes(n));
    const other = names.filter(n => !(n in SCRIPT_META));
    setScripts(names.length > 0 ? [...known, ...other] : FALLBACK_SCRIPTS);
  }, [withBle]);

  const handleAuth = useCallback(
    async (pin: string) => {
      setBusy(true);
      setPinError(false);
      try {
        const ok = await withBle(() => authenticate(pin));
        if (!ok) {
          setPinError(true);
          return;
        }
        pinRef.current = pin;
        await enterMenu();
      } catch (e) {
        setErrorText(`Authentication error: ${(e as Error).message}`);
        setStep('failed');
      } finally {
        setBusy(false);
      }
    },
    [enterMenu, withBle]
  );

  /* --- status ------------------------------------------------------------- */

  // One command at a time, each tolerated on its own: a row that can't be
  // read shows "—" rather than failing the view. Only a dead link is fatal,
  // and the connection watch handles that.
  const loadStatus = useCallback(async () => {
    const gen = ++statusGenRef.current;
    const alive = () => statusGenRef.current === gen && stepRef.current === 'status';
    setStatus({});
    setStatusLoading(true);
    try {
      await withBle(async () => {
        let daemon: RobotStatus['daemon'] = 'unreachable';
        try {
          if (await ping()) daemon = 'online';
        } catch {
          /* no reply at all: unreachable */
        }
        if (!alive()) return;
        setStatus(s => ({ ...s, daemon }));

        const net = await readNetworkInfo().catch(() => null);
        if (!alive()) return;
        setStatus(s => ({ ...s, net }));

        // Auth first so the reply carries the saved-network list; a refused
        // PIN here just means no `known` field, not a trip to the PIN step.
        await authenticate(pinRef.current).catch(() => false);
        const wifi = await wifiStatus().catch(() => null);
        if (!alive()) return;
        setStatus(s => ({ ...s, wifi }));

        const { hardwareId } = await readIdentity();
        if (!alive()) return;
        setStatus(s => ({ ...s, hardwareId }));
      });
    } finally {
      if (alive()) setStatusLoading(false);
    }
  }, [withBle]);

  const handleOpenStatus = useCallback(() => {
    setStep('status');
    void loadStatus();
  }, [loadStatus]);

  /* --- logs --------------------------------------------------------------- */

  const appendLog = useCallback((chunk: string) => {
    // The transport trims replies, which eats the newline a drained buffer
    // almost always ends with; a FULL chunk on the other hand is an
    // arbitrary 480-char slice, usually mid-line, so it joins seamlessly.
    const piece = isFullJournalChunk(chunk) ? chunk : `${chunk}\n`;
    setLogText(prev => {
      let next = prev + piece;
      if (next.length > LOG_CAP_CHARS) {
        const cut = next.indexOf('\n', next.length - LOG_CAP_CHARS);
        next = next.slice(cut >= 0 ? cut + 1 : next.length - LOG_CAP_CHARS);
      }
      return next;
    });
  }, []);

  // Poll loop for the logs view. One async function (not setInterval) so
  // reads never overlap; `journalGenRef` cancels it, after which it sends
  // the JOURNAL_STOP itself - so the stop can't race a read in flight.
  const startJournal = useCallback(() => {
    const gen = ++journalGenRef.current;
    const alive = () => journalGenRef.current === gen;
    journalPausedRef.current = false;
    setLogsPaused(false);
    setLogsError(null);
    void (async () => {
      try {
        await withBle(journalStart);
      } catch (e) {
        if (alive()) setLogsError(`Couldn't start the log stream: ${(e as Error).message}`);
        return;
      }
      let restarted = false;
      while (alive()) {
        if (!journalPausedRef.current) {
          let chunk = '';
          try {
            chunk = await withBle(journalRead);
          } catch (e) {
            const msg = (e as Error).message;
            // The robot stops the stream on its own (notify unsubscribe,
            // idle); restart it once and carry on.
            if (/not running/i.test(msg) && !restarted) {
              restarted = true;
              try {
                await withBle(journalStart);
                continue;
              } catch {
                /* fall through to the error below */
              }
            }
            if (alive()) setLogsError(`Log stream stopped: ${msg}`);
            return;
          }
          if (!alive()) break;
          if (chunk) appendLog(chunk);
          // A full chunk means the robot-side buffer is still draining.
          if (isFullJournalChunk(chunk)) continue;
        }
        await sleep(LOG_POLL_MS);
      }
    })();
  }, [appendLog, withBle]);

  const handleOpenLogs = useCallback(() => {
    setLogText('');
    setStep('logs');
    startJournal();
  }, [startJournal]);

  const handleToggleLogsPause = useCallback(() => {
    journalPausedRef.current = !journalPausedRef.current;
    setLogsPaused(journalPausedRef.current);
  }, []);

  /* --- update ------------------------------------------------------------- */

  // Must be called INSIDE `withBle` (after `ensureAuthed`).
  const runCheck = useCallback(async () => {
    setStep('checking');
    try {
      const r = await updateCheck();
      // The user backed out to the menu while we were waiting.
      if (stepRef.current !== 'checking') return;
      setCheck({ current: r.current, latest: r.latest });
      setStep(r.available ? 'available' : 'uptodate');
    } catch (e) {
      setErrorText(`Update check failed: ${(e as Error).message}`);
      setStep('failed');
    }
  }, []);

  const handleUpdate = useCallback(async () => {
    setBusy(true);
    try {
      await withBle(async () => {
        if (!(await ensureAuthed())) return;
        await runCheck();
      });
    } catch (e) {
      setErrorText(`Authentication error: ${(e as Error).message}`);
      setStep('failed');
    } finally {
      setBusy(false);
    }
  }, [ensureAuthed, runCheck, withBle]);

  const startPolling = useCallback(() => {
    stopPolling();
    let ticks = 0;
    let inFlight = false;
    const tick = async () => {
      const id = jobIdRef.current;
      // A tick is a PIN_ + UPDATE_INFO round trip that can outlast the
      // interval on a slow link: never stack them, and never let a late one
      // move a screen that already left `updating` (failed, rescanning…).
      if (!id || inFlight || stepRef.current !== 'updating') return;
      inFlight = true;
      try {
        const info = await withBle(async () => {
          // Keep the session alive: an install can outlast the 300 s TTL.
          await authenticate(pinRef.current).catch(() => false);
          return updateInfo(id);
        });
        if (stepRef.current !== 'updating') return;
        setProgress(info);
        if (TERMINAL_STATUSES.has(info.status)) {
          stopPolling();
          setStep(info.status === 'done' ? 'done' : 'failed');
          if (info.status === 'failed') setErrorText(info.last || 'The update failed on the robot.');
        }
      } catch {
        // A poll error here usually means the daemon restarted and tore
        // the BLE link down at the tail of the install. Treat it as a
        // soft success: the update was started and is finishing on the
        // robot. The user can reconnect to confirm the new version.
        if (stepRef.current !== 'updating') return;
        stopPolling();
        setStep('done');
      } finally {
        inFlight = false;
      }
      if (++ticks >= MAX_POLL_TICKS && stepRef.current === 'updating') {
        // Don't strand the user on a step that hides Back.
        stopPolling();
        setErrorText('The update is taking longer than expected. Reconnect later to check its version.');
        setStep('failed');
      }
    };
    void tick();
    pollTimer.current = setInterval(() => void tick(), POLL_INTERVAL_MS);
  }, [stopPolling, withBle]);

  const handleInstall = useCallback(async () => {
    setBusy(true);
    setProgress(null);
    try {
      const id = await withBle(async () => {
        if (!(await ensureAuthed())) return null;
        return updateStart();
      });
      if (id === null) return;
      jobIdRef.current = id;
      setStep('updating');
      startPolling();
    } catch (e) {
      setErrorText(`Could not start the update: ${(e as Error).message}`);
      setStep('failed');
    } finally {
      setBusy(false);
    }
  }, [ensureAuthed, startPolling, withBle]);

  /* --- recovery scripts --------------------------------------------------- */

  const handleRunScript = useCallback(
    async (name: string) => {
      setPendingScript(null);
      setResultScript(name);
      setLinkLost(false);
      setStep('running');
      const stillRunning = () => stepRef.current === 'running';
      try {
        await withBle(async () => {
          if (!(await ensureAuthed())) return;
          await runScript(name);
          if (stillRunning()) setStep('result');
        });
      } catch (e) {
        if (!stillRunning()) return;
        // `runScript` only throws here on an explicit robot-side refusal, or
        // on a transport error it couldn't settle with a PING - which means
        // the link is (about to be) gone. Give the connection watch a moment
        // to confirm the latter before calling it a failure.
        if (linkUpRef.current) await sleep(1_500);
        if (!stillRunning()) return;
        if (!linkUpRef.current) {
          setLinkLost(true);
          setStep('result');
          return;
        }
        const msg = e instanceof Error ? e.message : String(e);
        setErrorText(`Could not run ${scriptMeta(name).label.toLowerCase()}: ${msg}`);
        setStep('failed');
      }
    },
    [ensureAuthed, withBle]
  );

  /* --- navigation --------------------------------------------------------- */

  const handleExit = useCallback(() => {
    stopPolling();
    stopJournal();
    void bleDisconnect();
    onBack();
  }, [onBack, stopJournal, stopPolling]);

  const handleRetry = useCallback(() => {
    stopJournal();
    setErrorText(null);
    setLinkLost(false);
    setPendingScript(null);
    setDevices([]);
    // `failed` is reachable with the link still up (a refused command); the
    // radio can't scan and hold a connection at once, so drop it first.
    stepRef.current = 'scan';
    setStep('scan');
    void (async () => {
      if (linkUpRef.current) await bleDisconnect();
      runScan();
    })();
  }, [runScan, stopJournal]);

  // Contextual back: step to the PREVIOUS step instead of leaving the tool
  // outright. Only the first step (intro) and the terminal steps fall back
  // to a full exit; `updating` / `running` (and a connect / auth in flight)
  // hide the affordance entirely
  // (handled in the header) so an in-flight install or script can't be
  // interrupted.
  const handleBack = useCallback(() => {
    switch (stepRef.current) {
      case 'scan':
        void stopScanLoop();
        setScanning(false);
        setStep('intro');
        return;
      case 'pin':
      case 'menu':
        // We're connected to a robot here; drop the link and re-scan so the
        // user lands back on a fresh nearby list (radio can't scan + hold a
        // connection at once, so disconnect before scanning).
        setPinError(false);
        // Step to `scan` BEFORE dropping the link: the connection watch fires
        // on our own disconnect and must not read it as a lost link.
        stepRef.current = 'scan';
        setStep('scan');
        void (async () => {
          await bleDisconnect();
          runScan();
        })();
        return;
      case 'logs':
        stopJournal();
        setStep('menu');
        return;
      case 'result':
        // The script dropped the link (expected): nothing to go back to.
        if (linkLost) handleRetry();
        else setStep('menu');
        return;
      case 'status':
      case 'checking':
      case 'available':
      case 'uptodate':
        // BLE link stays alive; back to the tools menu.
        setStep('menu');
        return;
      default:
        // intro, updating, running, done, failed → full exit.
        handleExit();
    }
  }, [handleExit, handleRetry, linkLost, runScan, stopJournal, stopScanLoop]);

  const backToMenu = useCallback(() => setStep('menu'), []);
  const listLayout = step === 'scan' || step === 'menu' || step === 'status' || step === 'logs';

  return (
    <Stack
      sx={{
        height: '100%',
        bgcolor: 'background.default',
        pt: LAYOUT.safeAreaTop,
      }}
    >
      {/* Top bar: a back affordance that steps to the previous step (and only
          exits from intro / terminal steps). Hidden during `updating` and
          `running` so an in-flight install / script can't be interrupted. */}
      <Stack direction="row" sx={{ alignItems: 'center', px: 1, py: 1, flexShrink: 0, minHeight: 48 }}>
        {step !== 'updating' && step !== 'running' && !(busy && (step === 'scan' || step === 'pin')) && (
          <Button
            variant="text"
            aria-label="Back"
            onClick={handleBack}
            startIcon={<ArrowBackIosNewIcon sx={{ fontSize: 16 }} />}
            sx={{
              color: 'text.secondary',
              textTransform: 'none',
              fontWeight: FONT_WEIGHT.semibold,
            }}
          >
            Back
          </Button>
        )}
      </Stack>

      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: listLayout ? 'flex-start' : 'center',
          px: 3,
          pb: `calc(${LAYOUT.safeAreaBottom} + 24px)`,
        }}
      >
        <Box sx={{ width: '100%', maxWidth: 360 }}>
          {step === 'intro' && <IntroView onStart={handleStart} />}
          {step === 'scan' && (
            <ScanView
              devices={devices}
              scanning={scanning}
              busy={busy}
              connectingTo={connectingTo}
              onPick={handlePick}
              onRescan={runScan}
            />
          )}
          {step === 'pin' && <PinView busy={busy} error={pinError} onSubmit={handleAuth} />}
          {step === 'menu' && (
            <MenuView
              scripts={scripts}
              busy={busy}
              onStatus={handleOpenStatus}
              onLogs={handleOpenLogs}
              onUpdate={() => void handleUpdate()}
              onScript={setPendingScript}
            />
          )}
          {step === 'status' && (
            <StatusView status={status} loading={statusLoading} onRefresh={() => void loadStatus()} />
          )}
          {step === 'logs' && (
            <LogsView
              text={logText}
              paused={logsPaused}
              error={logsError}
              onTogglePause={handleToggleLogsPause}
              onClear={() => setLogText('')}
            />
          )}
          {step === 'running' && <RunningView />}
          {step === 'result' && resultScript && (
            <ResultView
              meta={scriptMeta(resultScript)}
              linkLost={linkLost}
              onRescan={handleRetry}
              onMenu={backToMenu}
              onDone={handleExit}
            />
          )}
          {step === 'checking' && <CheckingView />}
          {step === 'available' && (
            <AvailableView
              current={check.current}
              latest={check.latest}
              busy={busy}
              onInstall={handleInstall}
            />
          )}
          {step === 'uptodate' && <UpToDateView current={check.current} onDone={backToMenu} />}
          {step === 'updating' && <UpdatingView progress={progress} />}
          {step === 'done' && <DoneView latest={check.latest} onDone={handleExit} />}
          {step === 'failed' && <FailedView message={errorText} onRetry={handleRetry} onBack={handleExit} />}
        </Box>
      </Box>

      <ConfirmScriptDialog
        script={pendingScript}
        onCancel={() => setPendingScript(null)}
        onConfirm={name => void handleRunScript(name)}
      />
    </Stack>
  );
}

/* --- shared bits ---------------------------------------------------------- */

function Headline({ title, caption }: { title: string; caption?: string }) {
  return (
    <Stack spacing={0.75} sx={{ alignItems: 'center', textAlign: 'center' }}>
      <Typography sx={{ fontSize: TYPO.xl, fontWeight: FONT_WEIGHT.semibold }}>{title}</Typography>
      {caption ? (
        <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary', maxWidth: 300, lineHeight: 1.5 }}>
          {caption}
        </Typography>
      ) : null}
    </Stack>
  );
}

function PrimaryButton(props: React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="outlined"
      color="primary"
      fullWidth
      disableElevation
      {...props}
      sx={{
        textTransform: 'none',
        fontSize: TYPO.md,
        fontWeight: FONT_WEIGHT.semibold,
        borderRadius: `${RADIUS.md}px`,
        py: 1.25,
        ...props.sx,
      }}
    />
  );
}

function TextButton(props: React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="text"
      {...props}
      sx={{ textTransform: 'none', fontWeight: FONT_WEIGHT.semibold, ...props.sx }}
    />
  );
}

function IconHero({ children, tint }: { children: React.ReactNode; tint?: string }) {
  return (
    <Box
      sx={{
        width: LAYOUT.heroSizeSmall,
        height: LAYOUT.heroSizeSmall,
        borderRadius: RADIUS.circle,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: theme => alpha(tint ?? theme.palette.primary.main, 0.1),
        color: tint ?? 'primary.main',
      }}
    >
      {children}
    </Box>
  );
}

/** Framed card for the version / status rows. */
function InfoCard({ children }: { children: React.ReactNode }) {
  return (
    <Stack
      spacing={1}
      sx={theme => ({
        width: '100%',
        maxWidth: 320,
        p: 2,
        borderRadius: `${RADIUS.md}px`,
        border: `1px solid ${theme.palette.divider}`,
        bgcolor: 'background.paper',
      })}
    >
      {children}
    </Stack>
  );
}

/* --- 0. intro ------------------------------------------------------------- */

function IntroView({ onStart }: { onStart: () => void }) {
  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <IconHero>
        <BluetoothOutlinedIcon sx={{ fontSize: 52 }} />
      </IconHero>
      <Headline
        title="Bluetooth tools"
        caption="Update, check status, read logs or recover a Reachy nearby. Power it on and hold your phone close."
      />
      <Box sx={{ width: '100%', maxWidth: 320 }}>
        <PrimaryButton onClick={onStart}>Start</PrimaryButton>
      </Box>
    </Stack>
  );
}

/* --- 1. scan -------------------------------------------------------------- */

function ScanView({
  devices,
  scanning,
  busy,
  connectingTo,
  onPick,
  onRescan,
}: {
  devices: BleDevice[];
  scanning: boolean;
  busy: boolean;
  connectingTo: string | null;
  onPick: (d: BleDevice) => void;
  onRescan: () => void;
}) {
  const hasDevices = devices.length > 0;
  const connecting = connectingTo ? devices.find(d => d.address === connectingTo) : undefined;
  return (
    <Stack spacing={2.5} sx={{ alignItems: 'center', width: '100%' }}>
      <Headline
        title="Nearby Reachies"
        caption={
          connecting
            ? `Connecting to ${deviceLabel(connecting)}…`
            : hasDevices
              ? 'Tap the robot you want to work on.'
              : 'Scanning over Bluetooth…'
        }
      />
      {scanning && !hasDevices ? <CircularProgress size={28} sx={{ color: 'text.secondary' }} /> : null}

      {hasDevices ? (
        <List disablePadding sx={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 1.25 }}>
          {devices.map((d, i) => (
            <DeviceRow
              key={d.address}
              device={d}
              isClosest={devices.length > 1 && i === 0 && typeof d.rssi === 'number'}
              disabled={busy}
              connecting={d.address === connectingTo}
              onTap={() => onPick(d)}
            />
          ))}
        </List>
      ) : !scanning ? (
        <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary', textAlign: 'center', maxWidth: 300 }}>
          No Reachy found. Make sure it is powered on and held close to the phone, then scan again.
        </Typography>
      ) : null}

      {/* The scan runs continuously while this view is open, so there is no
          "Scan again" button in the normal case — a live indicator conveys
          that the list keeps refreshing. The manual restart only appears when
          the loop has actually stopped (e.g. permission denied / error). */}
      {scanning ? (
        hasDevices ? (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <CircularProgress size={14} sx={{ color: 'text.secondary' }} />
            <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary' }}>Still searching nearby…</Typography>
          </Stack>
        ) : null
      ) : connecting ? null : (
        // The loop is also stopped while a tapped row connects; the row's
        // own spinner is the feedback then, not a greyed "Scan again".
        <TextButton onClick={onRescan} startIcon={<RefreshIcon />} disabled={busy}>
          Scan again
        </TextButton>
      )}
    </Stack>
  );
}

/** Map a BLE RSSI (negative dBm) to the 3-bar {@link LinkQuality} scale. */
function rssiToLevel(rssi: number | undefined): LinkQuality {
  if (typeof rssi !== 'number') return 0;
  if (rssi >= -60) return 3;
  if (rssi >= -72) return 2;
  return 1;
}

/** Row title: the advertised name, or a generic fallback when it's absent. */
function deviceLabel(device: BleDevice): string {
  return device.name && device.name.trim().length > 0 ? device.name : 'Reachy';
}

function DeviceRow({
  device,
  isClosest = false,
  disabled = false,
  connecting = false,
  onTap,
}: {
  device: BleDevice;
  isClosest?: boolean;
  disabled?: boolean;
  /** This row was tapped and the link is being set up (takes a few seconds). */
  connecting?: boolean;
  onTap: () => void;
}) {
  const label = deviceLabel(device);
  const hasRssi = typeof device.rssi === 'number';
  return (
    <ListItemButton
      onClick={onTap}
      disabled={disabled}
      sx={{
        p: 1.5,
        borderRadius: '14px',
        bgcolor: 'background.paper',
        border: theme =>
          `1px solid ${
            connecting || isClosest ? alpha(theme.palette.primary.main, 0.5) : theme.palette.divider
          }`,
        // The tapped row must not grey out with its siblings: it's the one
        // thing that IS happening. The spinner in place of the chevron and
        // the "Connecting to…" caption carry the progress feedback.
        ...(connecting ? { '&.Mui-disabled': { opacity: 1 } } : {}),
      }}
    >
      <Stack direction="row" spacing={2} sx={{ alignItems: 'center', width: '100%' }}>
        <RobotAvatar size={44} />
        <Stack sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontSize: TYPO.md, fontWeight: FONT_WEIGHT.semibold }} noWrap>
            {label}
          </Typography>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', minWidth: 0 }}>
            <Typography
              sx={{ fontSize: TYPO.xs, fontFamily: 'monospace', color: 'text.secondary', opacity: 0.6 }}
              noWrap
            >
              #{device.address.slice(0, 8)}
            </Typography>
            {isClosest ? (
              <Typography
                sx={{ fontSize: TYPO.xs, fontWeight: FONT_WEIGHT.semibold, color: 'primary.main' }}
                noWrap
              >
                · Closest
              </Typography>
            ) : null}
          </Stack>
        </Stack>
        {hasRssi ? (
          <Box sx={{ flexShrink: 0 }}>
            <LinkQualityBars
              level={rssiToLevel(device.rssi)}
              title={`Signal strength: ${device.rssi} dBm`}
              scale={1.25}
            />
          </Box>
        ) : null}
        {connecting ? (
          <CircularProgress size={20} sx={{ color: 'primary.main', flexShrink: 0, mx: 0.25 }} />
        ) : (
          <ChevronRightIcon sx={{ color: 'primary.main', flexShrink: 0 }} />
        )}
      </Stack>
    </ListItemButton>
  );
}

/* --- 2. pin --------------------------------------------------------------- */

function PinView({
  busy,
  error,
  onSubmit,
}: {
  busy: boolean;
  error: boolean;
  onSubmit: (pin: string) => void;
}) {
  const [pin, setPin] = useState('');
  const ready = pin.length === PIN_LENGTH && !busy;
  const submit = () => {
    if (ready) onSubmit(pin);
  };
  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <IconHero>
        <LockOutlinedIcon sx={{ fontSize: 48 }} />
      </IconHero>
      <Headline title="Enter the setup code" caption="Find the 5-character code printed under your Reachy." />
      <TextField
        value={pin}
        onChange={e => setPin(e.target.value.trim().toUpperCase().slice(0, PIN_LENGTH))}
        onKeyDown={e => {
          if (e.key === 'Enter') submit();
        }}
        autoFocus
        error={error}
        helperText={error ? 'Incorrect code. Check the label under your Reachy.' : ' '}
        slotProps={{
          htmlInput: {
            inputMode: 'text',
            autoCapitalize: 'characters',
            'aria-label': 'Setup code',
            style: { textAlign: 'center', letterSpacing: '0.4em', fontFamily: 'monospace', fontSize: 22 },
          },
        }}
        sx={{ width: '100%', maxWidth: 240 }}
      />
      <Box sx={{ width: '100%', maxWidth: 320 }}>
        <PrimaryButton onClick={submit} disabled={!ready}>
          {busy ? 'Checking…' : 'Continue'}
        </PrimaryButton>
      </Box>
    </Stack>
  );
}

/* --- 3. menu -------------------------------------------------------------- */

function MenuView({
  scripts,
  busy,
  onStatus,
  onLogs,
  onUpdate,
  onScript,
}: {
  scripts: string[];
  busy: boolean;
  onStatus: () => void;
  onLogs: () => void;
  onUpdate: () => void;
  onScript: (name: string) => void;
}) {
  return (
    <Stack spacing={2.5} sx={{ width: '100%' }}>
      <Headline title="Bluetooth tools" caption="Connected to your Reachy." />
      <Section label="Robot">
        <MenuRow
          icon={<InfoOutlinedIcon fontSize="small" />}
          label="Status"
          caption="Network, Wi-Fi, software, hardware ID"
          disabled={busy}
          onTap={onStatus}
        />
        <MenuRow
          icon={<ArticleOutlinedIcon fontSize="small" />}
          label="Daemon logs"
          caption="Live output of the robot software"
          disabled={busy}
          onTap={onLogs}
        />
        <MenuRow
          icon={<SystemUpdateAltRoundedIcon fontSize="small" />}
          label="Update software"
          caption="Check for a newer version and install it"
          disabled={busy}
          onTap={onUpdate}
        />
      </Section>
      <Section label="Recovery">
        {scripts.map(name => {
          const meta = scriptMeta(name);
          return (
            <MenuRow
              key={name}
              icon={meta.icon}
              label={meta.label}
              caption={meta.caption}
              disabled={busy}
              onTap={() => onScript(name)}
            />
          );
        })}
      </Section>
    </Stack>
  );
}

/**
 * Tappable row inside a `<Section>` - the compact sibling of the Help &
 * Support overlay's `ActionRow` (icon, label, caption, trailing chevron),
 * with the same self-owned bottom divider so rows stack cleanly.
 */
function MenuRow({
  icon,
  label,
  caption,
  disabled = false,
  onTap,
}: {
  icon: React.ReactNode;
  label: string;
  caption?: string;
  disabled?: boolean;
  onTap: () => void;
}) {
  return (
    <Box
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label={caption ? `${label} (${caption})` : label}
      onClick={disabled ? undefined : onTap}
      onKeyDown={e => {
        if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onTap();
        }
      }}
      sx={theme => ({
        display: 'flex',
        alignItems: 'center',
        gap: 1.25,
        px: 1.5,
        py: 1.25,
        minHeight: 48,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        userSelect: 'none',
        WebkitTapHighlightColor: 'transparent',
        '&:not(:last-of-type)': { borderBottom: `1px solid ${theme.palette.divider}` },
        '&:active': { bgcolor: disabled ? undefined : 'action.hover' },
        '&:focus-visible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: -2 },
      })}
    >
      <Box
        sx={{
          flexShrink: 0,
          color: 'text.secondary',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
        }}
      >
        {icon}
      </Box>
      <Stack sx={{ flex: 1, minWidth: 0 }} spacing={0.125}>
        <Typography
          component="span"
          sx={{ fontSize: TYPO.md, fontWeight: FONT_WEIGHT.medium, color: 'text.primary', lineHeight: 1.3 }}
          noWrap
        >
          {label}
        </Typography>
        {caption && (
          <Typography
            component="span"
            sx={{ fontSize: TYPO.xs, color: 'text.secondary', lineHeight: 1.3 }}
            noWrap
          >
            {caption}
          </Typography>
        )}
      </Stack>
      <ChevronRightIcon aria-hidden sx={{ flexShrink: 0, fontSize: 18, color: 'text.disabled' }} />
    </Box>
  );
}

/* --- 4. status ------------------------------------------------------------ */

/** Every `[iface] ip` pair from the raw NETWORK_STATUS value, hotspot included. */
function allAddresses(net: RobotNetInfo): string {
  return Array.from(
    net.raw.matchAll(/\[([^\]]+)\]\s+(\d+\.\d+\.\d+\.\d+)/g),
    m => `${m[2]} (${m[1]})`
  ).join(', ');
}

const NET_MODE_LABEL: Record<RobotNetInfo['mode'], string> = {
  connected: 'Connected',
  hotspot: 'Hotspot',
  offline: 'Offline',
  unknown: '',
};

/** `value` undefined = still fetching (dim dash); '' = fetched, nothing to show. */
function StatusRow({ label, value, mono = false }: { label: string; value: string | undefined; mono?: boolean }) {
  return (
    <Stack
      direction="row"
      spacing={2}
      sx={{ justifyContent: 'space-between', alignItems: 'baseline', width: '100%' }}
    >
      <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary', flexShrink: 0 }}>{label}</Typography>
      <Typography
        sx={{
          fontSize: mono ? TYPO.sm : TYPO.md,
          fontWeight: FONT_WEIGHT.semibold,
          fontFamily: mono ? 'monospace' : undefined,
          textAlign: 'right',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          color: value === undefined ? 'text.disabled' : 'text.primary',
        }}
        noWrap={mono}
      >
        {value || '—'}
      </Typography>
    </Stack>
  );
}

function StatusView({
  status,
  loading,
  onRefresh,
}: {
  status: RobotStatus;
  loading: boolean;
  onRefresh: () => void;
}) {
  const daemon =
    status.daemon === undefined ? undefined : status.daemon === 'online' ? 'Online' : 'Unreachable';
  const net = status.net === undefined ? undefined : status.net ? NET_MODE_LABEL[status.net.mode] : '';
  const ips = status.net === undefined ? undefined : status.net ? allAddresses(status.net) : '';
  const ssid = status.wifi === undefined ? undefined : (status.wifi?.connected ?? '');
  const known = status.wifi === undefined ? undefined : (status.wifi?.known?.join(', ') ?? '');
  const hwid = status.hardwareId === undefined ? undefined : (status.hardwareId ?? '');
  return (
    <Stack spacing={2.5} sx={{ alignItems: 'center', width: '100%' }}>
      <Headline title="Robot status" />
      <InfoCard>
        <StatusRow label="Robot software" value={daemon} />
        <StatusRow label="Network mode" value={net} />
        <StatusRow label="Wi-Fi network" value={ssid} />
        <StatusRow label="IP address" value={ips} mono />
        <StatusRow label="Saved networks" value={known} />
        <StatusRow label="Hardware ID" value={hwid} mono />
      </InfoCard>
      <TextButton
        onClick={onRefresh}
        disabled={loading}
        startIcon={loading ? <CircularProgress size={14} sx={{ color: 'text.secondary' }} /> : <RefreshIcon />}
      >
        {loading ? 'Reading…' : 'Refresh'}
      </TextButton>
    </Stack>
  );
}

/* --- 5. logs: see `ble-tools/LogsView.tsx` (split out for size) ----------- */

/* --- 6. recovery scripts -------------------------------------------------- */

function ConfirmScriptDialog({
  script,
  onCancel,
  onConfirm,
}: {
  script: string | null;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  // Keep the last script's copy while the dialog fades out.
  const lastRef = useRef<string | null>(null);
  if (script) lastRef.current = script;
  const name = lastRef.current;
  const meta = name ? scriptMeta(name) : null;
  return (
    <Dialog
      open={script !== null}
      onClose={onCancel}
      slotProps={{ paper: { sx: { borderRadius: `${RADIUS.lg}px` } } }}
    >
      {meta && name ? (
        <>
          <DialogTitle sx={{ fontSize: TYPO.lg, fontWeight: FONT_WEIGHT.semibold }}>{meta.label}</DialogTitle>
          <DialogContent>
            <DialogContentText sx={{ fontSize: TYPO.sm }}>{meta.confirm}</DialogContentText>
          </DialogContent>
          <DialogActions sx={{ px: 2, pb: 1.5 }}>
            <TextButton onClick={onCancel} sx={{ color: 'text.secondary' }}>
              Cancel
            </TextButton>
            <TextButton color={meta.destructive ? 'error' : 'primary'} onClick={() => onConfirm(name)}>
              {meta.destructive ? 'Yes, do it' : 'Continue'}
            </TextButton>
          </DialogActions>
        </>
      ) : null}
    </Dialog>
  );
}

function RunningView() {
  return (
    <Stack spacing={2.5} sx={{ alignItems: 'center', width: '100%' }}>
      <CircularProgress size={40} sx={{ color: 'primary.main' }} />
      <Headline title="Sending command…" caption="This can take a few seconds while the robot runs it." />
    </Stack>
  );
}

function ResultView({
  meta,
  linkLost,
  onRescan,
  onMenu,
  onDone,
}: {
  meta: ScriptMeta;
  linkLost: boolean;
  onRescan: () => void;
  onMenu: () => void;
  onDone: () => void;
}) {
  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <IconHero tint={STATUS.success}>
        <SendRoundedIcon sx={{ fontSize: 48 }} />
      </IconHero>
      <Headline
        title="Command sent"
        caption={
          linkLost
            ? `${meta.after} The Bluetooth link closed while it restarts - scan again once it is back.`
            : meta.after
        }
      />
      <Stack spacing={1.25} sx={{ width: '100%', maxWidth: 320 }}>
        {linkLost ? (
          <PrimaryButton onClick={onRescan}>Scan again</PrimaryButton>
        ) : (
          <PrimaryButton onClick={onMenu}>Back to tools</PrimaryButton>
        )}
        <TextButton onClick={onDone}>Done</TextButton>
      </Stack>
    </Stack>
  );
}

/* --- 7. update: check ----------------------------------------------------- */

function CheckingView() {
  return (
    <Stack spacing={2.5} sx={{ alignItems: 'center', width: '100%' }}>
      <CircularProgress size={40} sx={{ color: 'primary.main' }} />
      <Headline title="Checking for updates…" caption="Asking your Reachy whether a newer version is available." />
    </Stack>
  );
}

function VersionRow({ label, value }: { label: string; value: string | null }) {
  return (
    <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'baseline', width: '100%' }}>
      <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary' }}>{label}</Typography>
      <Typography sx={{ fontSize: TYPO.md, fontWeight: FONT_WEIGHT.semibold, fontFamily: 'monospace' }}>
        {value ? `v${value}` : '—'}
      </Typography>
    </Stack>
  );
}

function AvailableView({
  current,
  latest,
  busy,
  onInstall,
}: {
  current: string | null;
  latest: string | null;
  busy: boolean;
  onInstall: () => void;
}) {
  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <IconHero>
        <SystemUpdateAltRoundedIcon sx={{ fontSize: 48 }} />
      </IconHero>
      <Headline
        title="Update available"
        caption="The robot will install the latest software and reboot. Keep it powered on and your phone nearby."
      />
      <InfoCard>
        <VersionRow label="Current" value={current} />
        <VersionRow label="Latest" value={latest} />
      </InfoCard>
      <Box sx={{ width: '100%', maxWidth: 320 }}>
        <PrimaryButton onClick={onInstall} disabled={busy}>
          {busy ? 'Starting…' : 'Install update'}
        </PrimaryButton>
      </Box>
    </Stack>
  );
}

function UpToDateView({ current, onDone }: { current: string | null; onDone: () => void }) {
  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <IconHero tint={STATUS.success}>
        <CheckCircleIcon sx={{ fontSize: 52 }} />
      </IconHero>
      <Headline
        title="Already up to date"
        caption={current ? `Your Reachy is running v${current}, the latest version.` : 'Your Reachy is on the latest version.'}
      />
      <Box sx={{ width: '100%', maxWidth: 320 }}>
        <PrimaryButton onClick={onDone}>Back to tools</PrimaryButton>
      </Box>
    </Stack>
  );
}

/* --- 8. update: updating -------------------------------------------------- */

function UpdatingView({ progress }: { progress: UpdateInfo | null }) {
  const phase =
    progress?.status === 'pending'
      ? 'Preparing the update…'
      : 'Installing the latest software…';
  return (
    <Stack spacing={2.5} sx={{ alignItems: 'center', width: '100%' }}>
      <CircularProgress size={44} sx={{ color: 'primary.main' }} />
      <Headline
        title="Updating your Reachy"
        caption="Keep the app open and your phone nearby. The robot will reboot when it's done - this can take a few minutes."
      />
      <Stack
        spacing={0.5}
        sx={theme => ({
          width: '100%',
          maxWidth: 320,
          p: 1.5,
          borderRadius: `${RADIUS.md}px`,
          border: `1px solid ${theme.palette.divider}`,
          bgcolor: 'background.paper',
        })}
      >
        <Typography sx={{ fontSize: TYPO.sm, fontWeight: FONT_WEIGHT.semibold }}>{phase}</Typography>
        {progress?.last ? (
          <Typography
            sx={{ fontSize: TYPO.xs, fontFamily: 'monospace', color: 'text.secondary', wordBreak: 'break-word' }}
          >
            {progress.last}
          </Typography>
        ) : null}
      </Stack>
    </Stack>
  );
}

/* --- 9. terminal ---------------------------------------------------------- */

function DoneView({ latest, onDone }: { latest: string | null; onDone: () => void }) {
  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <IconHero tint={STATUS.success}>
        <CheckCircleIcon sx={{ fontSize: 52 }} />
      </IconHero>
      <Headline
        title="Update complete"
        caption={
          latest
            ? `Your Reachy is updating to v${latest} and will restart. You can reconnect from the robot list once it is back.`
            : 'Your Reachy is finishing the update and will restart. You can reconnect from the robot list once it is back.'
        }
      />
      <Box sx={{ width: '100%', maxWidth: 320 }}>
        <PrimaryButton onClick={onDone}>Done</PrimaryButton>
      </Box>
    </Stack>
  );
}

function FailedView({
  message,
  onRetry,
  onBack,
}: {
  message: string | null;
  onRetry: () => void;
  onBack: () => void;
}) {
  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <IconHero tint={STATUS.error}>
        <ErrorOutlineRoundedIcon sx={{ fontSize: 52 }} />
      </IconHero>
      <Headline
        title="Something went wrong"
        caption={message ?? 'Make sure the robot is on and close, then try again.'}
      />
      <Stack spacing={1.25} sx={{ width: '100%', maxWidth: 320 }}>
        <PrimaryButton onClick={onRetry}>Try again</PrimaryButton>
        <TextButton onClick={onBack}>Back</TextButton>
      </Stack>
    </Stack>
  );
}
