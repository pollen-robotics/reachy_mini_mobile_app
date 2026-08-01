/**
 * First-time setup wizard.
 *
 * Provisions a brand-new Reachy Mini Wireless onto the user's Wi-Fi over
 * Bluetooth only (the user never joins the robot's hotspot). Reached from the
 * "Set up a new Reachy" CTA on `ScanScreen`; on success it hands the freshly
 * registered robot back to the host for a normal session.
 *
 * The flow is owned by `useSetupMachine` (FSM + BLE/crypto orchestration).
 * This file is the presentation layer: a shared shell (4-step header +
 * back/cancel) plus one view per phase. Subcomponents live in this file by
 * the same convention as `ScanScreen.tsx`.
 *
 * See `docs/FIRST_TIME_SETUP_PLAN.md` for the design rationale and the ASCII
 * mockups this implements.
 */

import { AnimatePresence, motion } from 'motion/react';
import { useRef, useState } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  Stack,
  TextField,
  Typography,
  alpha,
} from '@mui/material';
import ArrowBackIosNewIcon from '@mui/icons-material/ArrowBackIosNew';
import BluetoothIcon from '@mui/icons-material/Bluetooth';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import WifiIcon from '@mui/icons-material/Wifi';
import RefreshIcon from '@mui/icons-material/Refresh';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import WifiLockIcon from '@mui/icons-material/WifiLock';

import type { BleDevice } from '@/features/ble/bleWifi';
import { useSetupMachine, type SetupMachine } from '@/features/ble-provisioning/useSetupMachine';
import { type SetupPhase, type SetupResult } from '@/features/ble-provisioning/types';
import { openAppSettings, openExternalUrl } from '@/shared/tauri/openUrl';
import { getPlatform } from '@/shared/platform';
import { LinkQualityBars, type LinkQuality } from '@/ui/design/LinkQualityBars';
import RobotAvatar from '@/ui/design/RobotAvatar';
import { FONT_WEIGHT, LAYOUT, RADIUS, STATUS, TYPO } from '@/ui/design/tokens';
import serialNumberImg from '@/assets/serial-number.jpg';

/** The PIN printed under the robot is the 5-char serial suffix. */
const PIN_LENGTH = 5;

/** Showcase site download page (Reachy Mini website Space). Where users grab
 *  the desktop app that can update a robot too old for Bluetooth Wi-Fi setup.
 *  Mirrors `DaemonUpdateGate`'s desktop-app fallback. */
const DESKTOP_APP_DOWNLOAD_URL = 'https://pollen-robotics-reachy-mini-website.hf.space/download';

/** Public troubleshooting docs (same target as the Help & Support overlay). */
const TROUBLESHOOTING_URL = 'https://huggingface.co/docs/reachy_mini/troubleshooting';

/** Total perceived steps shown as "Step N of 4" in the header. */
const TOTAL_STEPS = 4;

/**
 * Fine-grained 0→1 fill for the top progress bar. The *step number* comes from
 * {@link stageForPhase} (4 perceived stages); this map just lets the bar creep
 * forward smoothly within a stage so it always feels alive.
 */
const PHASE_FRACTION: Record<SetupPhase, number> = {
  permission: 0.05,
  scanning: 0.12,
  connecting: 0.2,
  pin: 0.27,
  authenticating: 0.34,
  'wifi-scanning': 0.46,
  'wifi-pick': 0.56,
  'wifi-password': 0.66,
  'wifi-connecting': 0.76,
  'linking-account': 0.84,
  'central-waiting': 0.93,
  done: 1,
  error: 0,
};

interface SetupWizardScreenProps {
  token: string;
  /** Leave the wizard and return to the robot list. */
  onCancel: () => void;
  /** Provisioning finished. `result.robot` is the central listing when it
   *  appeared in time (→ open a session), else null (→ back to the list). */
  onComplete: (result: SetupResult) => void;
}

export default function SetupWizardScreen({ token, onCancel, onComplete }: SetupWizardScreenProps) {
  const m = useSetupMachine({ token });
  const fraction = useClampedProgress(m.phase);
  const showProgress = m.phase !== 'error';
  const step = stepFromFraction(fraction);

  return (
    <Stack
      sx={{
        height: '100%',
        width: '100%',
        bgcolor: 'background.default',
        color: 'text.primary',
      }}
    >
      {/* Edge-to-edge progress bar, flush to the top of the wizard surface. A
          thin track is always present so the filled portion reads as progress
          (not a buffering spinner); it animates as the flow advances. */}
      <Box sx={{ height: 3, width: '100%', bgcolor: theme => alpha(theme.palette.text.primary, 0.08) }}>
        <Box
          sx={{
            height: '100%',
            width: showProgress ? `${fraction * 100}%` : '0%',
            bgcolor: 'primary.main',
            transition: 'width 400ms cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        />
      </Box>

      {/* Top bar: back/close on the left, step counter on the right. Back always
          exits the wizard - BLE teardown is handled on unmount by the FSM. */}
      <Stack
        direction="row"
        sx={{
          alignItems: 'center',
          justifyContent: 'space-between',
          pt: `calc(${LAYOUT.safeAreaTop} + 12px)`,
          pb: 1,
          px: 1,
        }}
      >
        <Button
          aria-label="Cancel setup"
          onClick={onCancel}
          startIcon={<ArrowBackIosNewIcon sx={{ fontSize: 16 }} />}
          sx={{
            color: 'text.secondary',
            textTransform: 'none',
            fontWeight: FONT_WEIGHT.semibold,
            fontSize: TYPO.sm,
            borderRadius: 999,
          }}
        >
          Back
        </Button>
        {showProgress ? (
          <Typography sx={{ pr: 1.5, fontSize: TYPO.xs, color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>
            {`Step ${step} of ${TOTAL_STEPS}`}
          </Typography>
        ) : null}
      </Stack>

      {/* Scrollable content column. Each phase cross-fades + lifts in/out so the
          flow feels like turning pages rather than hard cuts. */}
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
              key={m.phase}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.26, ease: [0.4, 0, 0.2, 1] }}
              style={{ width: '100%' }}
            >
              <StepView m={m} onCancel={onCancel} onComplete={onComplete} />
            </motion.div>
          </AnimatePresence>
        </Stack>
      </Stack>
    </Stack>
  );
}

/* --- step router ---------------------------------------------------------- */

function StepView({
  m,
  onCancel,
  onComplete,
}: {
  m: SetupMachine;
  onCancel: () => void;
  onComplete: (result: SetupResult) => void;
}) {
  if (m.phase === 'error' && m.error) {
    // An outdated robot can't be fixed by retrying the BLE flow - it needs a
    // software update first. Route it to the dedicated "update from the desktop
    // app" view (mirrors the in-session `DaemonUpdateGate`) instead of the
    // generic "Something went wrong / Try again" error.
    if (m.error.code === 'robot-outdated') {
      return <OutdatedView message={m.error.message} onCancel={onCancel} />;
    }
    // A denied Bluetooth permission can't be recovered by retrying the scan
    // (iOS never re-prompts after a refusal; Android won't either once the
    // user picked "Don't allow again"). Route it to a dedicated gate that
    // explains why and deep-links to Settings instead of the generic
    // "Something went wrong / Try again" error.
    if (m.error.code === 'permission-denied') {
      return <PermissionDeniedView onRetry={m.retry} onCancel={onCancel} />;
    }
    return <ErrorView message={m.error.message} onRetry={m.retry} onCancel={onCancel} />;
  }
  switch (m.phase) {
    case 'scanning':
      return <ScanView devices={m.devices} scanning={m.scanning} onPick={m.selectDevice} onRescan={m.rescan} />;
    case 'connecting':
      return <BusyView title="Saying hello" caption="Opening a Bluetooth link…" />;
    case 'pin':
      return <PinView onSubmit={m.submitPin} />;
    case 'authenticating':
      return <BusyView title="Checking the code" caption="One moment…" />;
    case 'wifi-scanning':
      return <BusyView title="Finding networks" caption="Scanning nearby Wi-Fi (~10 s)…" />;
    case 'wifi-pick':
      return <WifiPickView networks={m.networks} onPick={m.selectNetwork} onRescan={m.rescanWifi} />;
    case 'wifi-password':
      return <PasswordView ssid={m.selectedSsid ?? ''} onSubmit={m.submitPassword} />;
    case 'wifi-connecting':
      return <ConnectingView ssid={m.selectedSsid ?? ''} stage="joining" />;
    case 'linking-account':
      return <LinkAccountView onLink={m.linkAccount} lanIp={m.robotLanIp} />;
    case 'central-waiting':
      return <ConnectingView ssid={m.selectedSsid ?? ''} stage="registering" />;
    case 'done':
      return <SuccessView result={m.result} onComplete={onComplete} onBackToList={onCancel} />;
    default:
      return null;
  }
}

/* --- shared bits ---------------------------------------------------------- */

/**
 * Monotonic 0→1 progress for the header bar. A sub-step retry (wrong PIN, Wi-Fi
 * rescan) never makes it jump backward; it only resets when the flow genuinely
 * restarts pairing (permission/scanning) or hits an error.
 */
function useClampedProgress(phase: SetupPhase): number {
  const maxRef = useRef(0);
  const target = PHASE_FRACTION[phase] ?? 0;
  if (phase === 'permission' || phase === 'scanning' || phase === 'error') {
    maxRef.current = target;
  } else {
    maxRef.current = Math.max(maxRef.current, target);
  }
  return maxRef.current;
}

/** Perceived "Step N of 4" derived from the clamped fill (stays monotonic). */
function stepFromFraction(f: number): number {
  if (f < 0.42) return 1;
  if (f < 0.72) return 2;
  if (f < 0.97) return 3;
  return TOTAL_STEPS;
}

function Headline({ title, caption }: { title: string; caption?: string }) {
  return (
    <Stack spacing={0.75} sx={{ alignItems: 'center', textAlign: 'center' }}>
      <Typography sx={{ fontSize: TYPO.xxl, fontWeight: FONT_WEIGHT.semibold }}>{title}</Typography>
      {caption ? (
        <Typography sx={{ fontSize: TYPO.md, color: 'text.secondary', maxWidth: 320, lineHeight: 1.5 }}>
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

function SecondaryButton(props: React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="outlined"
      fullWidth
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
        bgcolor: theme => alpha(tint ?? theme.palette.primary.main, 0.1),
        color: tint ?? 'primary.main',
      }}
    >
      {children}
    </Box>
  );
}

/* --- 1. permission primer ------------------------------------------------- */

/* --- 1. BLE scan ---------------------------------------------------------- */

function ScanView({
  devices,
  scanning,
  onPick,
  onRescan,
}: {
  devices: BleDevice[];
  scanning: boolean;
  onPick: (d: BleDevice) => void;
  onRescan: () => void;
}) {
  const hasDevices = devices.length > 0;
  return (
    <Stack spacing={2.5} sx={{ alignItems: 'center', width: '100%' }}>
      <Headline
        title="Let's wake up your Reachy"
        caption={
          hasDevices
            ? "Found it. Tap your Reachy and we'll set it up over Bluetooth - no Wi-Fi needed yet."
            : "Power your Reachy on and hold it close. We'll reach it over Bluetooth to hand over your Wi-Fi - this only takes a moment."
        }
      />
      {scanning && !hasDevices ? (
        <CircularProgress size={28} sx={{ color: 'text.secondary' }} />
      ) : null}

      {hasDevices ? (
        <List disablePadding sx={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 1.25 }}>
          {devices.map((d, i) => (
            <DeviceRow
              key={d.address}
              device={d}
              isClosest={devices.length > 1 && i === 0 && typeof d.rssi === 'number'}
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
      ) : (
        <Button
          onClick={onRescan}
          startIcon={<RefreshIcon />}
          sx={{ textTransform: 'none', fontWeight: FONT_WEIGHT.semibold }}
        >
          Scan again
        </Button>
      )}
    </Stack>
  );
}

/**
 * Map a BLE advertisement RSSI (negative dBm, closer to 0 = stronger) to
 * the 3-bar {@link LinkQuality} scale. The breakpoints mirror the usual
 * "near / same room / far" buckets for BLE proximity. A missing RSSI
 * (some Android stacks omit it) renders muted/empty bars.
 */
function rssiToLevel(rssi: number | undefined): LinkQuality {
  if (typeof rssi !== 'number') return 0;
  if (rssi >= -60) return 3;
  if (rssi >= -72) return 2;
  return 1;
}

function DeviceRow({
  device,
  isClosest = false,
  onTap,
}: {
  device: BleDevice;
  isClosest?: boolean;
  onTap: () => void;
}) {
  const label = device.name && device.name.trim().length > 0 ? device.name : 'Reachy';
  const hasRssi = typeof device.rssi === 'number';
  return (
    <ListItemButton
      onClick={onTap}
      sx={{
        p: 1.5,
        borderRadius: '14px',
        bgcolor: 'background.paper',
        border: theme =>
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

/* --- 3. PIN --------------------------------------------------------------- */

function PinView({ onSubmit }: { onSubmit: (pin: string) => void }) {
  const [pin, setPin] = useState('');
  const ready = pin.length === PIN_LENGTH;
  const submit = () => {
    if (ready) onSubmit(pin);
  };
  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      {/* Slight 3D-tilted photo card: a soft drop shadow + a couple
          degrees of perspective rotation give the serial-number shot a
          gentle "held in hand" feel without reading as a gimmick. */}
      <Box sx={{ width: '100%', display: 'flex', justifyContent: 'center', perspective: '1000px' }}>
        <Box
          sx={{
            width: '100%',
            maxWidth: 280,
            bgcolor: 'background.paper',
            borderRadius: `${RADIUS.lg}px`,
            border: theme => `1px solid ${alpha(theme.palette.text.primary, 0.22)}`,
            boxShadow: '0 3px 10px rgba(0, 0, 0, 0.12)',
            overflow: 'hidden',
            transform: 'rotateX(2deg) rotateY(-2deg)',
            transformStyle: 'preserve-3d',
          }}
        >
          <Box
            component="img"
            src={serialNumberImg}
            alt="The 5-character code is printed on a label under your Reachy's base"
            sx={{
              width: '100%',
              display: 'block',
              userSelect: 'none',
              pointerEvents: 'none',
            }}
          />
        </Box>
      </Box>
      <Headline title="Prove it's yours" caption="Type the 5-character code printed under your Reachy's base." />
      <TextField
        value={pin}
        onChange={e => setPin(e.target.value.replace(/\s/g, '').slice(0, PIN_LENGTH))}
        onKeyDown={e => {
          if (e.key === 'Enter') submit();
        }}
        autoFocus
        slotProps={{
          htmlInput: {
            inputMode: 'text',
            autoCapitalize: 'characters',
            'aria-label': 'Setup code',
            style: {
              textAlign: 'center',
              fontFamily: 'monospace',
              fontSize: '1.8rem',
              letterSpacing: '0.5rem',
              fontWeight: 600,
            },
          },
        }}
        sx={{ width: 240 }}
      />
      <Box sx={{ width: 240 }}>
        <SecondaryButton onClick={submit} disabled={!ready}>
          Verify
        </SecondaryButton>
      </Box>
    </Stack>
  );
}

/* --- 4. Wi-Fi pick -------------------------------------------------------- */

function WifiPickView({
  networks,
  onPick,
  onRescan,
}: {
  networks: string[];
  onPick: (ssid: string) => void;
  onRescan: () => void;
}) {
  return (
    <Stack spacing={2.5} sx={{ alignItems: 'center', width: '100%' }}>
      <Headline title="Pick a home network" caption="Choose the Wi-Fi your Reachy will live on." />
      {networks.length > 0 ? (
        <List disablePadding sx={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 1 }}>
          {networks.map(ssid => (
            <ListItemButton
              key={ssid}
              onClick={() => onPick(ssid)}
              sx={{
                p: 1.5,
                borderRadius: '12px',
                bgcolor: 'background.paper',
                border: theme => `1px solid ${theme.palette.divider}`,
              }}
            >
              <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', width: '100%' }}>
                <WifiLockIcon sx={{ color: 'text.secondary', fontSize: 20 }} />
                <Typography sx={{ flex: 1, minWidth: 0, fontSize: TYPO.md }} noWrap>
                  {ssid}
                </Typography>
                <ChevronRightIcon sx={{ color: 'primary.main', flexShrink: 0 }} />
              </Stack>
            </ListItemButton>
          ))}
        </List>
      ) : (
        <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary', textAlign: 'center', maxWidth: 300 }}>
          No networks found nearby. Move the robot closer to your router and rescan.
        </Typography>
      )}
      <Button onClick={onRescan} startIcon={<RefreshIcon />} sx={{ textTransform: 'none', fontWeight: FONT_WEIGHT.semibold }}>
        Rescan
      </Button>
    </Stack>
  );
}

/* --- 5. password ---------------------------------------------------------- */

function PasswordView({ ssid, onSubmit }: { ssid: string; onSubmit: (psk: string) => void }) {
  const [psk, setPsk] = useState('');
  const [show, setShow] = useState(false);
  return (
    <Stack spacing={2.5} sx={{ alignItems: 'center', width: '100%' }}>
      <Headline title="The secret handshake" caption={`Enter the password for "${ssid}".`} />
      <TextField
        value={psk}
        onChange={e => setPsk(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && psk.length > 0) onSubmit(psk);
        }}
        type={show ? 'text' : 'password'}
        label="Wi-Fi password"
        autoFocus
        fullWidth
        sx={{ maxWidth: 320 }}
        slotProps={{
          input: {
            endAdornment: (
              <InputAdornment position="end">
                <IconButton
                  aria-label={show ? 'Hide password' : 'Show password'}
                  onClick={() => setShow(s => !s)}
                  edge="end"
                  size="small"
                >
                  {show ? <VisibilityOffIcon /> : <VisibilityIcon />}
                </IconButton>
              </InputAdornment>
            ),
          },
        }}
      />
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', color: 'text.secondary' }}>
        <LockOutlinedIcon sx={{ fontSize: 14 }} />
        <Typography sx={{ fontSize: TYPO.xs }}>Encrypted on this phone before it's sent</Typography>
      </Stack>
      <Box sx={{ width: '100%', maxWidth: 320 }}>
        <SecondaryButton onClick={() => onSubmit(psk)} disabled={psk.length === 0}>
          Connect
        </SecondaryButton>
      </Box>
    </Stack>
  );
}

/* --- 6. connecting / central-waiting -------------------------------------- */

function ConnectingView({ ssid, stage }: { ssid: string; stage: 'joining' | 'registering' }) {
  const title = stage === 'joining' ? 'Bringing it online' : 'Almost there';
  const caption =
    stage === 'joining'
      ? `Joining ${ssid || 'the network'}…`
      : 'Registering with Hugging Face…';
  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <Headline title={title} caption={caption} />
      <CircularProgress size={26} sx={{ color: 'primary.main' }} />
    </Stack>
  );
}

/* --- 6b. link account (robot-side Hugging Face OAuth) --------------------- */

function LinkAccountView({ onLink, lanIp }: { onLink: () => void; lanIp: string | null }) {
  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <Headline
        title="Link your Reachy"
        caption="Sign in with Hugging Face so your Reachy can come online. We'll open your browser — keep this phone on the same Wi-Fi as the robot."
      />
      <RobotAddressNote lanIp={lanIp} />
      <Box sx={{ width: '100%', maxWidth: 320 }}>
        <PrimaryButton onClick={onLink}>Sign in with Hugging Face</PrimaryButton>
      </Box>
    </Stack>
  );
}

/**
 * Tell the user how we'll reach the robot for the OAuth step. When we read its
 * LAN IP over Bluetooth we show it (the reliable path); otherwise we fall back
 * to mDNS by name and say so, so a failure to resolve isn't a mystery.
 */
function RobotAddressNote({ lanIp }: { lanIp: string | null }) {
  if (lanIp) {
    return (
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: 'center',
          px: 1.5,
          py: 1,
          borderRadius: RADIUS.md,
          bgcolor: alpha(STATUS.success, 0.12),
        }}
      >
        <WifiIcon sx={{ fontSize: 18, color: STATUS.success }} />
        <Typography sx={{ fontSize: TYPO.sm, color: 'text.primary' }}>
          Found your Reachy at{' '}
          <Box
            component="span"
            sx={{ fontWeight: FONT_WEIGHT.semibold, fontVariantNumeric: 'tabular-nums' }}
          >
            {lanIp}
          </Box>
        </Typography>
      </Stack>
    );
  }
  return (
    <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary', textAlign: 'center', maxWidth: 300 }}>
      We'll reach your Reachy by name on your Wi-Fi (reachy-mini.local).
    </Typography>
  );
}

/* --- 7. success ----------------------------------------------------------- */

function SuccessView({
  result,
  onComplete,
  onBackToList,
}: {
  result: SetupResult | null;
  onComplete: (result: SetupResult) => void;
  onBackToList: () => void;
}) {
  const robot = result?.robot ?? null;
  const name = robot?.meta?.name ?? robot?.name ?? 'Your Reachy';
  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <Box sx={{ position: 'relative' }}>
        <motion.div
          initial={{ scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 380, damping: 22 }}
        >
          <RobotAvatar size={96} />
        </motion.div>
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: 'spring', stiffness: 520, damping: 18, delay: 0.18 }}
          style={{ position: 'absolute', right: -4, bottom: -4, display: 'flex' }}
        >
          <CheckCircleIcon
            sx={{
              fontSize: 32,
              color: STATUS.success,
              bgcolor: 'background.default',
              borderRadius: RADIUS.circle,
            }}
          />
        </motion.div>
      </Box>
      <Headline
        title={robot ? `Meet ${name}` : 'Wi-Fi set up!'}
        caption={
          robot
            ? "It's online and ready to chat."
            : 'Your Reachy joined the network. It will show up in your list in a few moments.'
        }
      />
      <Box sx={{ width: '100%', maxWidth: 320 }}>
        {robot ? (
          <PrimaryButton onClick={() => result && onComplete(result)}>{`Open ${name}`}</PrimaryButton>
        ) : (
          <PrimaryButton onClick={onBackToList}>Back to all Reachies</PrimaryButton>
        )}
      </Box>
    </Stack>
  );
}

/* --- error ---------------------------------------------------------------- */

function ErrorView({
  message,
  onRetry,
  onCancel,
}: {
  message: string;
  onRetry: () => void;
  onCancel: () => void;
}) {
  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <IconHero tint={STATUS.error}>
        <ErrorOutlineIcon sx={{ fontSize: 48 }} />
      </IconHero>
      <Headline title="Something went wrong" caption={message} />
      <Box sx={{ width: '100%', maxWidth: 320 }}>
        <Stack spacing={1.25}>
          <PrimaryButton onClick={onRetry}>Try again</PrimaryButton>
          <Button onClick={onCancel} sx={{ textTransform: 'none', fontWeight: FONT_WEIGHT.semibold }}>
            Cancel setup
          </Button>
        </Stack>
      </Box>
    </Stack>
  );
}

/* --- bluetooth permission gate -------------------------------------------- */

/**
 * Shown when the OS reports the Bluetooth permission as denied. This is a
 * dead-end for a plain "Try again": iOS only ever raises its CoreBluetooth
 * prompt once, and Android stops prompting after "Don't allow again" - so
 * the real recovery path is the system Settings.
 *
 * Copy + actions are platform-tailored:
 *  - iOS: a one-tap "Open Settings" (`app-settings:`) deep-link is the
 *    primary action; "Try again" re-runs the scan after the user flips it.
 *  - Android: "Try again" is primary (a soft denial re-raises the "Nearby
 *    devices" dialog); the copy walks a hard denial to Settings manually,
 *    since there's no reliable per-app settings URL to deep-link to.
 */
function PermissionDeniedView({
  onRetry,
  onCancel,
}: {
  onRetry: () => void;
  onCancel: () => void;
}) {
  const isIos = getPlatform() === 'ios';
  const caption = isIos
    ? 'Reachy Mini needs Bluetooth to set up your robot. Open Settings to allow it, then come back and tap Try again.'
    : 'Reachy Mini needs the Nearby devices permission to find your robot. Tap Try again and allow it - if you dismissed it, enable it in Settings › Apps › Reachy Mini › Permissions.';
  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <IconHero>
        <BluetoothIcon sx={{ fontSize: 48 }} />
      </IconHero>
      <Headline title="Allow Bluetooth access" caption={caption} />
      <Box sx={{ width: '100%', maxWidth: 320 }}>
        <Stack spacing={1.25}>
          {isIos ? (
            <>
              <PrimaryButton onClick={() => void openAppSettings()}>Open Settings</PrimaryButton>
              <SecondaryButton onClick={onRetry}>Try again</SecondaryButton>
            </>
          ) : (
            <PrimaryButton onClick={onRetry}>Try again</PrimaryButton>
          )}
          <Button onClick={onCancel} sx={{ textTransform: 'none', fontWeight: FONT_WEIGHT.semibold }}>
            Cancel setup
          </Button>
        </Stack>
      </Box>
    </Stack>
  );
}

/* --- outdated robot ------------------------------------------------------- */

/**
 * Shown when the robot's software is too old to provision Wi-Fi over Bluetooth
 * (pre-v1.8.2: `WIFI_SCAN` is unsupported). Unlike a transient error, there is
 * no "Try again": fixing it means updating from the Reachy desktop app, which
 * takes the robot offline and reboots it, tearing down this BLE session. The
 * user must update, then start setup fresh (Cancel → back to the robot list).
 * Mirrors the desktop-app fallback of the in-session `DaemonUpdateGate`.
 */
function OutdatedView({
  message,
  onCancel,
}: {
  message: string;
  onCancel: () => void;
}) {
  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <Headline title="Update from the desktop app" caption={message} />
      <Box sx={{ width: '100%', maxWidth: 320 }}>
        <Stack spacing={1.25}>
          <PrimaryButton onClick={() => void openExternalUrl(DESKTOP_APP_DOWNLOAD_URL)}>
            Get the desktop app ↗
          </PrimaryButton>
          <Button
            onClick={() => void openExternalUrl(TROUBLESHOOTING_URL)}
            sx={{ textTransform: 'none', fontWeight: FONT_WEIGHT.medium, color: 'text.secondary' }}
          >
            Open troubleshooting guide ↗
          </Button>
          <Button
            onClick={onCancel}
            sx={{ textTransform: 'none', fontWeight: FONT_WEIGHT.semibold }}
          >
            Cancel
          </Button>
        </Stack>
      </Box>
    </Stack>
  );
}

/* --- generic busy --------------------------------------------------------- */

function BusyView({ title, caption }: { title: string; caption?: string }) {
  return (
    <Stack spacing={3} sx={{ alignItems: 'center', width: '100%' }}>
      <CircularProgress size={32} sx={{ color: 'primary.main' }} />
      <Headline title={title} caption={caption} />
    </Stack>
  );
}
