/**
 * BLE WiFi-provisioning DEBUG screen.
 *
 * A minimal harness to exercise the robot's new BLE WiFi commands over the
 * real Android/iOS BLE transport (see `features/ble/bleWifi.ts` and the daemon
 * doc `BLE_WIFI_PROVISIONING.md`). Not a product UX — buttons + a log pane.
 *
 * Mounted via `BleDevEntry` (a floating button) alongside <App/> so it is
 * reachable regardless of auth/scan state and touches none of the app flow.
 * Gate it behind `import.meta.env.DEV` at the mount site if you don't want it
 * in release builds.
 */

import { useState, useCallback, useEffect } from 'react';
import {
  Box,
  Button,
  Dialog,
  Fab,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import {
  scanDevices,
  looksLikeReachy,
  connect,
  disconnect,
  watchConnection,
  sendCommand,
  buildSealedConnect,
  type BleDevice,
} from '@/features/ble/bleWifi';

function useLog() {
  const [lines, setLines] = useState<string[]>([]);
  const log = useCallback((s: string) => {
    setLines((prev) => [...prev, s].slice(-200));
  }, []);
  return { lines, log, clear: () => setLines([]) };
}

function BleWifiDebugScreen({ onClose }: { onClose: () => void }) {
  const { lines, log, clear } = useLog();
  const [connected, setConnected] = useState(false);
  const [devices, setDevices] = useState<BleDevice[]>([]);
  const [pin, setPin] = useState('01202');
  const [ssid, setSsid] = useState('');
  const [psk, setPsk] = useState('');

  // Wrap a step so every action logs its outcome and never throws into React.
  const run = useCallback(
    (label: string, fn: () => Promise<string | void>) => async () => {
      log(`▸ ${label}`);
      try {
        const r = await fn();
        if (r) log(`  ${r}`);
      } catch (e) {
        log(`  ✗ ${(e as Error).message ?? String(e)}`);
      }
    },
    [log],
  );

  const onScan = run('scan (15s)', async () => {
    setDevices([]);
    const found = await scanDevices(15000, (live) => setDevices(live), log);
    // Log the raw object of each device so we can see exactly what the
    // plugin returns (name is often null on Android — match by service then).
    for (const d of found) {
      const tag = looksLikeReachy(d) ? '  ★ ' : '    ';
      log(`${tag}${d.name ?? '(no name)'} [${d.address}] ${JSON.stringify(d.raw)}`);
    }
    setDevices(found);
    return `${found.length} device(s); ${found.filter(looksLikeReachy).length} look like Reachy`;
  });

  // Drive `connected` from the plugin's REAL connection signal (the plugin's
  // connect() swallows errors, so we can't trust its promise alone).
  useEffect(() => {
    void watchConnection((c) => setConnected(c), log);
  }, [log]);

  const onConnectAddr = (addr: string) =>
    run(`connect ${addr}`, async () => {
      await connect(addr, log);
      // Fallback flip in case the connection-state channel is quiet; the
      // watcher will correct it to false on a real disconnect.
      setConnected(true);
      return 'connected';
    })();

  const onDisconnect = run('disconnect', async () => {
    await disconnect();
    setConnected(false);
    return 'disconnected';
  });

  const onPing = run('PING', () => sendCommand('PING'));
  const onStatus = run('WIFI_STATUS', () => sendCommand('WIFI_STATUS'));
  const onAuth = run(`PIN_${pin}`, () => sendCommand(`PIN_${pin}`));
  const onKeyex = run('WIFI_KEYEX', () => sendCommand('WIFI_KEYEX'));
  const onWifiScan = run('WIFI_SCAN', () => sendCommand('WIFI_SCAN', 25000));
  const onForgetTest = run('WIFI_FORGET Hotspot (gating test)', () =>
    sendCommand('WIFI_FORGET Hotspot'),
  );

  // Full sealed provisioning: auth → keyex → seal → connect_enc.
  const onProvision = run('provision (sealed)', async () => {
    const auth = await sendCommand(`PIN_${pin}`);
    log(`  auth: ${auth}`);
    const keyex = await sendCommand('WIFI_KEYEX');
    log(`  keyex: ${keyex}`);
    const cmd = buildSealedConnect(ssid, psk, pin, keyex);
    log(`  sealed blob built (${cmd.length} chars)`);
    return await sendCommand(cmd);
  });

  const btn = { variant: 'outlined' as const, size: 'small' as const };

  return (
    <Dialog open fullScreen onClose={onClose}>
      <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', height: '100%', gap: 1.5 }}>
        <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography variant="h6">BLE WiFi debug</Typography>
          <Button onClick={onClose}>Close</Button>
        </Stack>

        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Button {...btn} onClick={onScan}>
            Scan
          </Button>
          <Button {...btn} onClick={onDisconnect} disabled={!connected}>
            Disconnect
          </Button>
          <Typography variant="body2">
            {connected ? '● connected' : '○ disconnected'}
          </Typography>
        </Stack>

        {/* Discovered devices — tap to connect. Reachy candidates (matched by
            name OR advertised service UUID) are starred and listed first. */}
        {devices.length > 0 && !connected && (
          <Stack spacing={0.5} sx={{ maxHeight: 140, overflow: 'auto' }}>
            {[...devices]
              .sort((a, b) => Number(looksLikeReachy(b)) - Number(looksLikeReachy(a)))
              .map((d) => (
                <Button
                  key={d.address}
                  {...btn}
                  onClick={() => onConnectAddr(d.address)}
                  sx={{ justifyContent: 'flex-start', textTransform: 'none' }}
                >
                  {looksLikeReachy(d) ? '★ ' : ''}
                  {d.name ?? '(no name)'} · {d.address}
                  {typeof d.rssi === 'number' ? ` · ${d.rssi}dBm` : ''}
                </Button>
              ))}
          </Stack>
        )}

        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
          <Button {...btn} onClick={onPing} disabled={!connected}>
            Ping
          </Button>
          <Button {...btn} onClick={onStatus} disabled={!connected}>
            Status
          </Button>
          <Button {...btn} onClick={onKeyex} disabled={!connected}>
            KeyEx
          </Button>
          <Button {...btn} onClick={onWifiScan} disabled={!connected}>
            Scan WiFi
          </Button>
          <Button {...btn} onClick={onForgetTest} disabled={!connected}>
            Forget(test)
          </Button>
        </Stack>

        <TextField
          label="PIN"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          size="small"
        />
        <Button {...btn} onClick={onAuth} disabled={!connected}>
          Authenticate (PIN_)
        </Button>

        <Stack direction="row" spacing={1}>
          <TextField
            label="SSID"
            value={ssid}
            onChange={(e) => setSsid(e.target.value)}
            size="small"
            fullWidth
          />
          <TextField
            label="Password"
            value={psk}
            onChange={(e) => setPsk(e.target.value)}
            size="small"
            fullWidth
          />
        </Stack>
        <Button
          variant="contained"
          onClick={onProvision}
          disabled={!connected || !ssid}
        >
          Provision (sealed connect)
        </Button>

        <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography variant="subtitle2">Log</Typography>
          <Button size="small" onClick={clear}>
            Clear
          </Button>
        </Stack>
        <Box
          sx={{
            flex: 1,
            overflow: 'auto',
            bgcolor: '#0b0b0b',
            color: '#c8c8c8',
            fontFamily: 'monospace',
            fontSize: 12,
            p: 1,
            borderRadius: 1,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {lines.join('\n') || 'Tap Connect to begin.'}
        </Box>
      </Box>
    </Dialog>
  );
}

/**
 * Floating launcher. Mount once alongside <App/>. Renders a small FAB that
 * opens the debug screen. Wrap the mount in `import.meta.env.DEV` to keep it
 * out of release builds.
 */
export function BleDevEntry() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Fab
        size="small"
        color="secondary"
        onClick={() => setOpen(true)}
        sx={{ position: 'fixed', bottom: 16, left: 16, zIndex: 2000, opacity: 0.85 }}
        aria-label="BLE WiFi debug"
      >
        BLE
      </Fab>
      {open && <BleWifiDebugScreen onClose={() => setOpen(false)} />}
    </>
  );
}

export default BleWifiDebugScreen;
