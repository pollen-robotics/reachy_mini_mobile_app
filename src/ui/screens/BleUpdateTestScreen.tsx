/**
 * Throwaway test screen for the daemon's "update over BLE" feature
 * (pollen-robotics/reachy_mini#1172).
 *
 * Drives the full client flow by hand so we can exercise the new GATT commands
 * against a real robot before doing a clean integration:
 *
 *   scan → connect → PIN_<pin> → UPDATE_CHECK → UPDATE_START → poll UPDATE_INFO
 *
 * Everything (TX/RX) is also logged to the webview console by the transport
 * layer; this screen mirrors the high-level steps into an on-screen log so it's
 * usable on-device without devtools.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  Divider,
  IconButton,
  List,
  ListItemButton,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';

import {
  type BleDevice,
  connect as bleConnect,
  disconnect as bleDisconnect,
  looksLikeReachy,
  scanDevices,
  watchConnection,
} from '@/features/ble/bleWifi';
import { authenticate } from '@/features/ble-provisioning/protocol';
import {
  updateCheck,
  updateInfo,
  updateStart,
} from '@/features/ble-provisioning/updateProtocol';

type Step = 'scan' | 'connect' | 'pin' | 'update';

const POLL_INTERVAL_MS = 3000;
const TERMINAL_STATUSES = new Set(['done', 'failed']);

export default function BleUpdateTestScreen({ onBack }: { onBack: () => void }) {
  const [step, setStep] = useState<Step>('scan');
  const [devices, setDevices] = useState<BleDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [pin, setPin] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const log = useCallback((s: string) => {
    setLines((prev) => [...prev, s]);
  }, []);

  // Track the real connection state from the plugin (its connect() can't be
  // trusted to report success — see bleWifi.ts).
  useEffect(() => {
    void watchConnection((c) => {
      setConnected(c);
      if (!c) log('• BLE link down');
    });
  }, [log]);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const handleScan = useCallback(async () => {
    setBusy(true);
    setDevices([]);
    log('Scanning…');
    try {
      const all = await scanDevices(12000, (live) => setDevices(live), log);
      const reachies = all.filter(looksLikeReachy);
      log(`Scan done: ${all.length} device(s), ${reachies.length} Reachy-like`);
    } catch (e) {
      log(`✗ Scan failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [log]);

  const handleConnect = useCallback(
    async (d: BleDevice) => {
      setBusy(true);
      log(`Connecting to ${d.name ?? d.address}…`);
      try {
        await bleConnect(d.address, log);
        log('✓ Connected');
        setStep('pin');
      } catch (e) {
        log(`✗ Connect failed: ${(e as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [log],
  );

  const handleAuth = useCallback(async () => {
    setBusy(true);
    log(`Authenticating (PIN ${pin.length} chars)…`);
    try {
      const ok = await authenticate(pin);
      if (ok) {
        log('✓ Authenticated');
        setStep('update');
      } else {
        log('✗ Incorrect PIN');
      }
    } catch (e) {
      log(`✗ Auth error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [pin, log]);

  const handleCheck = useCallback(async () => {
    setBusy(true);
    log('UPDATE_CHECK…');
    try {
      const r = await updateCheck();
      log(
        `✓ available=${r.available} current=${r.current ?? '?'} latest=${r.latest ?? '?'}`,
      );
    } catch (e) {
      log(`✗ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [log]);

  const handleStart = useCallback(async () => {
    setBusy(true);
    log('UPDATE_START…');
    try {
      const id = await updateStart();
      setJobId(id);
      log(`✓ Update started, job=${id}`);
    } catch (e) {
      log(`✗ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [log]);

  const handlePoll = useCallback(() => {
    if (!jobId) {
      log('No job id yet — run UPDATE_START first');
      return;
    }
    stopPolling();
    log(`Polling UPDATE_INFO ${jobId} every ${POLL_INTERVAL_MS / 1000}s…`);
    const tick = async () => {
      try {
        const info = await updateInfo(jobId);
        log(`  [${info.status}] lines=${info.lines} ${info.last}`);
        if (TERMINAL_STATUSES.has(info.status)) {
          stopPolling();
          log(`✓ Finished: ${info.status}`);
        }
      } catch (e) {
        stopPolling();
        log(`✗ Poll error: ${(e as Error).message}`);
      }
    };
    void tick();
    pollTimer.current = setInterval(() => void tick(), POLL_INTERVAL_MS);
  }, [jobId, log, stopPolling]);

  const handleDisconnect = useCallback(async () => {
    stopPolling();
    await bleDisconnect();
    setStep('scan');
    setJobId(null);
    log('Disconnected');
  }, [log, stopPolling]);

  return (
    <Stack sx={{ height: '100%', p: 2, gap: 1.5, overflow: 'hidden' }}>
      <Stack sx={{ flexDirection: 'row', alignItems: 'center', gap: 1 }}>
        <IconButton onClick={onBack} edge="start">
          <ArrowBackIcon />
        </IconButton>
        <Typography variant="h6">BLE Daemon Update (test)</Typography>
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" color={connected ? 'success.main' : 'text.secondary'}>
          {connected ? '● linked' : '○ offline'}
        </Typography>
      </Stack>

      {step === 'scan' && (
        <>
          <Button variant="contained" onClick={handleScan} disabled={busy}>
            {busy ? 'Scanning…' : 'Scan'}
          </Button>
          <List dense sx={{ maxHeight: 200, overflow: 'auto' }}>
            {devices.map((d) => (
              <ListItemButton
                key={d.address}
                disabled={busy}
                onClick={() => handleConnect(d)}
                sx={{ opacity: looksLikeReachy(d) ? 1 : 0.5 }}
              >
                <Stack>
                  <Typography variant="body2">
                    {d.name ?? '(no name)'} {looksLikeReachy(d) ? '· Reachy' : ''}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {d.address} {d.rssi != null ? `· ${d.rssi}dBm` : ''}
                  </Typography>
                </Stack>
              </ListItemButton>
            ))}
          </List>
        </>
      )}

      {step === 'pin' && (
        <Stack sx={{ flexDirection: 'row', gap: 1 }}>
          <TextField
            label="Setup code (PIN)"
            value={pin}
            onChange={(e) => setPin(e.target.value.trim())}
            size="small"
            autoFocus
          />
          <Button variant="contained" onClick={handleAuth} disabled={busy || !pin}>
            Authenticate
          </Button>
        </Stack>
      )}

      {step === 'update' && (
        <Stack sx={{ flexDirection: 'row', gap: 1, flexWrap: 'wrap' }}>
          <Button variant="outlined" onClick={handleCheck} disabled={busy}>
            Check
          </Button>
          <Button variant="contained" onClick={handleStart} disabled={busy}>
            Start
          </Button>
          <Button variant="outlined" onClick={handlePoll} disabled={busy || !jobId}>
            Poll info
          </Button>
          <Button color="error" onClick={handleDisconnect}>
            Disconnect
          </Button>
        </Stack>
      )}

      <Divider />

      <Box
        sx={{
          flex: 1,
          overflow: 'auto',
          fontFamily: 'monospace',
          fontSize: 12,
          whiteSpace: 'pre-wrap',
          bgcolor: 'rgba(0,0,0,0.3)',
          borderRadius: 1,
          p: 1,
        }}
      >
        {lines.map((l, i) => (
          <div key={i}>{l}</div>
        ))}
      </Box>
    </Stack>
  );
}
