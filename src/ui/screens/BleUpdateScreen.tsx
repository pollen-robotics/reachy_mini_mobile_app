/**
 * Update over Bluetooth.
 *
 * A standalone maintenance tool reachable from the pre-connection Help
 * & Support overlay. It updates a Reachy's daemon directly over BLE -
 * useful when the robot isn't on Wi-Fi yet, or to recover one that
 * won't come online for a normal WebRTC session.
 *
 *   intro → scan → pin → check ─┬─ up to date  → done
 *                               └─ available → updating → done / failed
 *
 * The BLE commands (`UPDATE_CHECK` / `UPDATE_START` / `UPDATE_INFO`,
 * see pollen-robotics/reachy_mini#1172) proxy to the daemon's `/update/*`
 * HTTP API and all require a prior `PIN_<pin>` auth. Unlike the Wi-Fi
 * provisioning commands they do NOT reset the session, so we chain
 * check → start → poll on one connection.
 *
 * This replaces the throwaway `BleUpdateTestScreen`: same protocol, a
 * real guided UX that reuses the setup wizard's device card + signal
 * bars.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  List,
  ListItemButton,
  Stack,
  TextField,
  Typography,
  alpha,
} from '@mui/material';
import ArrowBackIosNewIcon from '@mui/icons-material/ArrowBackIosNew';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import SystemUpdateAltRoundedIcon from '@mui/icons-material/SystemUpdateAltRounded';

import {
  type BleDevice,
  type ScanController,
  connect as bleConnect,
  disconnect as bleDisconnect,
  reachyBySignal,
  startContinuousScan,
  watchConnection,
} from '@/features/ble/bleWifi';
import { authenticate } from '@/features/ble-provisioning/protocol';
import {
  updateCheck,
  updateInfo,
  updateStart,
  type UpdateInfo,
} from '@/features/ble-provisioning/updateProtocol';
import { LinkQualityBars, type LinkQuality } from '@/ui/design/LinkQualityBars';
import RobotAvatar from '@/ui/design/RobotAvatar';
import { FONT_WEIGHT, LAYOUT, RADIUS, STATUS, TYPO } from '@/ui/design/tokens';

/** The PIN printed under the robot is the 5-char serial suffix. */
const PIN_LENGTH = 5;
const POLL_INTERVAL_MS = 3_000;
/** Stop polling after this many ticks (~10 min) as a safety net. */
const MAX_POLL_TICKS = 200;
const TERMINAL_STATUSES = new Set(['done', 'failed']);

type Step =
  | 'intro'
  | 'scan'
  | 'pin'
  | 'checking'
  | 'available'
  | 'uptodate'
  | 'updating'
  | 'done'
  | 'failed';

export default function BleUpdateScreen({ onBack }: { onBack: () => void }) {
  const [step, setStep] = useState<Step>('intro');
  const [devices, setDevices] = useState<BleDevice[]>([]);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pinError, setPinError] = useState(false);
  const [check, setCheck] = useState<{ current: string | null; latest: string | null }>({
    current: null,
    latest: null,
  });
  const [progress, setProgress] = useState<UpdateInfo | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const jobIdRef = useRef<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const scanCtrlRef = useRef<ScanController | null>(null);
  const stepRef = useRef<Step>(step);
  stepRef.current = step;

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const stopScanLoop = useCallback(async () => {
    const ctrl = scanCtrlRef.current;
    scanCtrlRef.current = null;
    if (ctrl) await ctrl.stop();
  }, []);

  // Clean teardown: stop the poll + scan loops and drop the BLE link whenever
  // the tool unmounts, regardless of which step we were on.
  useEffect(
    () => () => {
      stopPolling();
      void scanCtrlRef.current?.stop();
      scanCtrlRef.current = null;
      void bleDisconnect();
    },
    [stopPolling],
  );

  // Watch the real link state. A drop during the auth/check window is a
  // hard failure (the user moved away / robot powered off); during the
  // update itself the poll loop is authoritative, so we ignore it there.
  useEffect(() => {
    void watchConnection((connected) => {
      if (connected) return;
      const s = stepRef.current;
      if (s === 'pin' || s === 'checking' || s === 'available') {
        setErrorText('The Bluetooth connection to your Reachy was lost.');
        setStep('failed');
      }
    });
  }, []);

  // Continuous scan: keeps the nearby list live the whole time the scan step
  // is up (new robots appear, vanished ones drop out) instead of one frozen
  // sweep. Restarted on refocus and explicit rescan; stopped before connect.
  const runScan = useCallback(() => {
    setScanning(true);
    setDevices([]);
    void stopScanLoop();
    scanCtrlRef.current = startContinuousScan({
      onUpdate: (live) => setDevices(reachyBySignal(live)),
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
      try {
        // The radio can't scan and connect at once — stop the loop first.
        await stopScanLoop();
        setScanning(false);
        await bleConnect(d.address);
        setStep('pin');
      } catch (e) {
        setErrorText(`Could not connect: ${(e as Error).message}`);
        setStep('failed');
      } finally {
        setBusy(false);
      }
    },
    [stopScanLoop],
  );

  const runCheck = useCallback(async () => {
    setStep('checking');
    try {
      const r = await updateCheck();
      setCheck({ current: r.current, latest: r.latest });
      setStep(r.available ? 'available' : 'uptodate');
    } catch (e) {
      setErrorText(`Update check failed: ${(e as Error).message}`);
      setStep('failed');
    }
  }, []);

  const handleAuth = useCallback(
    async (pin: string) => {
      setBusy(true);
      setPinError(false);
      try {
        const ok = await authenticate(pin);
        if (!ok) {
          setPinError(true);
          return;
        }
        await runCheck();
      } catch (e) {
        setErrorText(`Authentication error: ${(e as Error).message}`);
        setStep('failed');
      } finally {
        setBusy(false);
      }
    },
    [runCheck],
  );

  const startPolling = useCallback(() => {
    stopPolling();
    let ticks = 0;
    const tick = async () => {
      const id = jobIdRef.current;
      if (!id) return;
      try {
        const info = await updateInfo(id);
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
        stopPolling();
        setStep('done');
      }
      if (++ticks >= MAX_POLL_TICKS) stopPolling();
    };
    void tick();
    pollTimer.current = setInterval(() => void tick(), POLL_INTERVAL_MS);
  }, [stopPolling]);

  const handleInstall = useCallback(async () => {
    setBusy(true);
    setProgress(null);
    try {
      const id = await updateStart();
      jobIdRef.current = id;
      setStep('updating');
      startPolling();
    } catch (e) {
      setErrorText(`Could not start the update: ${(e as Error).message}`);
      setStep('failed');
    } finally {
      setBusy(false);
    }
  }, [startPolling]);

  const handleExit = useCallback(() => {
    stopPolling();
    void bleDisconnect();
    onBack();
  }, [onBack, stopPolling]);

  const handleRetry = useCallback(() => {
    setErrorText(null);
    setDevices([]);
    setStep('scan');
    void runScan();
  }, [runScan]);

  return (
    <Stack
      sx={{
        height: '100%',
        bgcolor: 'background.default',
        pt: LAYOUT.safeAreaTop,
      }}
    >
      {/* Top bar: a single back affordance that always exits the tool
          (BLE teardown happens on unmount + here). */}
      <Stack direction="row" sx={{ alignItems: 'center', px: 1, py: 1, flexShrink: 0 }}>
        <Button
          aria-label="Close updater"
          onClick={handleExit}
          startIcon={<ArrowBackIosNewIcon sx={{ fontSize: 16 }} />}
          sx={{
            color: 'text.secondary',
            textTransform: 'none',
            fontWeight: FONT_WEIGHT.semibold,
          }}
        >
          Back
        </Button>
      </Stack>

      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: step === 'scan' ? 'flex-start' : 'center',
          px: 3,
          pb: `calc(${LAYOUT.safeAreaBottom} + 24px)`,
        }}
      >
        <Box sx={{ width: '100%', maxWidth: 360 }}>
          {step === 'intro' && <IntroView onStart={handleStart} />}
          {step === 'scan' && (
            <ScanView devices={devices} scanning={scanning} busy={busy} onPick={handlePick} onRescan={runScan} />
          )}
          {step === 'pin' && <PinView busy={busy} error={pinError} onSubmit={handleAuth} />}
          {step === 'checking' && <CheckingView />}
          {step === 'available' && (
            <AvailableView
              current={check.current}
              latest={check.latest}
              busy={busy}
              onInstall={handleInstall}
            />
          )}
          {step === 'uptodate' && <UpToDateView current={check.current} onDone={handleExit} />}
          {step === 'updating' && <UpdatingView progress={progress} />}
          {step === 'done' && <DoneView latest={check.latest} onDone={handleExit} />}
          {step === 'failed' && <FailedView message={errorText} onRetry={handleRetry} onBack={handleExit} />}
        </Box>
      </Box>
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
      variant="contained"
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
        bgcolor: (theme) => alpha(tint ?? theme.palette.primary.main, 0.1),
        color: tint ?? 'primary.main',
      }}
    >
      {children}
    </Box>
  );
}

/* --- 0. intro ------------------------------------------------------------- */

function IntroView({ onStart }: { onStart: () => void }) {
  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <IconHero>
        <SystemUpdateAltRoundedIcon sx={{ fontSize: 52 }} />
      </IconHero>
      <Headline
        title="Update over Bluetooth"
        caption="Use this when a Reachy isn't on Wi-Fi yet, or to recover one that won't connect. Power it on and hold your phone close to the robot."
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
  onPick,
  onRescan,
}: {
  devices: BleDevice[];
  scanning: boolean;
  busy: boolean;
  onPick: (d: BleDevice) => void;
  onRescan: () => void;
}) {
  const hasDevices = devices.length > 0;
  return (
    <Stack spacing={2.5} sx={{ alignItems: 'center', width: '100%' }}>
      <Headline
        title="Nearby Reachies"
        caption={hasDevices ? 'Tap the robot you want to update.' : 'Scanning over Bluetooth…'}
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
              onTap={() => onPick(d)}
            />
          ))}
        </List>
      ) : !scanning ? (
        <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary', textAlign: 'center', maxWidth: 300 }}>
          No Reachy found. Make sure it is powered on and held close to the phone, then scan again.
        </Typography>
      ) : null}

      {/* Live affordance: the list keeps refreshing while the view is open. */}
      {scanning && hasDevices ? (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <CircularProgress size={14} sx={{ color: 'text.secondary' }} />
          <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary' }}>Still searching nearby…</Typography>
        </Stack>
      ) : null}

      <Button
        onClick={onRescan}
        startIcon={<RefreshIcon />}
        disabled={busy}
        sx={{ textTransform: 'none', fontWeight: FONT_WEIGHT.semibold }}
      >
        Scan again
      </Button>
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

function DeviceRow({
  device,
  isClosest = false,
  disabled = false,
  onTap,
}: {
  device: BleDevice;
  isClosest?: boolean;
  disabled?: boolean;
  onTap: () => void;
}) {
  const label = device.name && device.name.trim().length > 0 ? device.name : 'Reachy';
  const hasRssi = typeof device.rssi === 'number';
  return (
    <ListItemButton
      onClick={onTap}
      disabled={disabled}
      sx={{
        p: 1.5,
        borderRadius: '14px',
        bgcolor: 'background.paper',
        border: (theme) =>
          `1px solid ${isClosest ? alpha(theme.palette.primary.main, 0.5) : theme.palette.divider}`,
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
        <ChevronRightIcon sx={{ color: 'primary.main', flexShrink: 0 }} />
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
        onChange={(e) => setPin(e.target.value.trim().toUpperCase().slice(0, PIN_LENGTH))}
        onKeyDown={(e) => {
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

/* --- 3. check ------------------------------------------------------------- */

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
      <Stack
        spacing={1}
        sx={(theme) => ({
          width: '100%',
          maxWidth: 320,
          p: 2,
          borderRadius: `${RADIUS.md}px`,
          border: `1px solid ${theme.palette.divider}`,
          bgcolor: 'background.paper',
        })}
      >
        <VersionRow label="Current" value={current} />
        <VersionRow label="Latest" value={latest} />
      </Stack>
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
        <PrimaryButton onClick={onDone}>Done</PrimaryButton>
      </Box>
    </Stack>
  );
}

/* --- 4. updating ---------------------------------------------------------- */

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
        sx={(theme) => ({
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

/* --- 5. terminal ---------------------------------------------------------- */

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
      <Headline title="Update couldn't complete" caption={message ?? 'Something went wrong. Make sure the robot is on and close, then try again.'} />
      <Stack spacing={1.25} sx={{ width: '100%', maxWidth: 320 }}>
        <PrimaryButton onClick={onRetry}>Try again</PrimaryButton>
        <Button onClick={onBack} sx={{ textTransform: 'none', fontWeight: FONT_WEIGHT.semibold }}>
          Back
        </Button>
      </Stack>
    </Stack>
  );
}
