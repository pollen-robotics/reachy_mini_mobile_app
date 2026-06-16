/**
 * BLE WiFi-provisioning client (Android/iOS) for Reachy Mini.
 *
 * Talks to the robot's GATT command service (see the daemon repo:
 * `daemon/app/services/bluetooth/BLE_WIFI_PROVISIONING.md`). The phone is the
 * BLE central; we write UTF-8 command strings to the COMMAND characteristic and
 * read results back on the RESPONSE characteristic.
 *
 * Two concerns live here, deliberately separated:
 *   1. TRANSPORT  — thin wrappers over `@mnlphlp/plugin-blec`. If the installed
 *      plugin version's API differs, this is the ONLY place to adjust.
 *   2. CRYPTO     — the sealed-password scheme `x25519-hkdf-sha256-aesgcm`,
 *      mirrored byte-for-byte from the daemon (verified end-to-end in Python).
 *      The WiFi password is encrypted here and never leaves the phone in
 *      cleartext — the App-Store-review requirement that motivated this.
 *
 * Response model (matches the daemon): a write returns a SYNCHRONOUS reply on
 * the RESPONSE value (`PONG`, `OK: Connected`, or the `OK: working` ack). For
 * the WiFi commands the real result then arrives as a NOTIFICATION. So we read
 * the sync reply and, when it is `OK: working`, await the next notification.
 */

import {
  startScan,
  stopScan,
  checkPermissions,
  getConnectionUpdates,
  connect as blecConnect,
  disconnect as blecDisconnect,
  sendString,
  readString,
  subscribeString,
} from '@mnlphlp/plugin-blec';

import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { gcm } from '@noble/ciphers/aes';

// ─── GATT contract (must match the daemon) ──────────────────────────────────
export const CMD_CHAR = '12345678-1234-5678-1234-56789abcdef1';
export const RESP_CHAR = '12345678-1234-5678-1234-56789abcdef2';
// Read-only status characteristics exposed by the daemon's GATT app. Reading
// these (post-connect) is how we learn the robot's identity + Wi-Fi state,
// since the v2 advert carries no identity (all robots advertise "ReachyMini").
export const NETWORK_STATUS_CHAR = '12345678-1234-5678-1234-56789abcdef4';
export const HARDWARE_ID_CHAR = '12345678-1234-5678-1234-56789abcdef7';
const REACHY_NAME_RE = /reachy/i;

// HKDF domain-separation label — identical literal on the daemon.
const HKDF_INFO = new TextEncoder().encode('reachy-mini-wifi-psk-v1');
const WORKING_ACK = 'OK: working';

// ─── base64 helpers ──────────────────────────────────────────────────────────
function u8ToB64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
function b64ToU8(b64: string): Uint8Array {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

// ─── Transport ───────────────────────────────────────────────────────────────
// One pending-notification waiter + a small backlog queue, so a notification
// that lands before we start awaiting it is not lost.
let _notifResolve: ((s: string) => void) | null = null;
const _notifBacklog: string[] = [];
let _subscribed = false;

// BLE wire logging, to the webview devtools console (visible under
// `yarn tauri:dev`). The native plugin logs WRITES it issues but NOT the data
// we read back / receive as notifications — this fills that gap on the JS side.
const _log = (s: string): void => console.debug(`[ble] ${s}`);

/** Redact secrets (the PIN) and trim verbose blobs for logging. */
function _redactCmd(cmd: string): string {
  if (cmd.startsWith('PIN_')) return 'PIN_*****';
  if (cmd.startsWith('WIFI_CONNECT_ENC ')) return 'WIFI_CONNECT_ENC {…sealed…}';
  return cmd;
}

function _onNotification(text: string): void {
  const t = text.trim();
  if (_notifResolve) {
    _log(`RX notif (awaited) ← ${JSON.stringify(t)} (${t.length}B)`);
    const r = _notifResolve;
    _notifResolve = null;
    r(t);
  } else {
    // No one is awaiting yet — this happens when a FAST command's result lands
    // before our sync read grabs it. Keep it, but each sendCommand clears the
    // backlog first so a stale entry can't be mis-served to the next command.
    _log(`RX notif (backlogged) ← ${JSON.stringify(t)} (${t.length}B)`);
    _notifBacklog.push(t);
  }
}

function _awaitNotification(timeoutMs: number): Promise<string> {
  const queued = _notifBacklog.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  return new Promise((resolve, reject) => {
    _notifResolve = resolve;
    setTimeout(() => {
      if (_notifResolve === resolve) {
        _notifResolve = null;
        reject(new Error(`response timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);
  });
}

// The plugin's device object shape varies by version; keep it permissive and
// surface the raw object so the UI can show exactly what came back.
export interface BleDevice {
  address: string;
  name?: string | null;
  services?: string[];
  rssi?: number;
  raw: unknown; // the untouched plugin object, for diagnostics
}

function normalizeDevice(d: Record<string, unknown>): BleDevice {
  // Different plugin versions use address|id|uuid and name|localName.
  const address = String(d.address ?? d.id ?? d.uuid ?? '');
  const nameRaw = d.name ?? d.localName;
  const name = typeof nameRaw === 'string' ? nameRaw : null;
  const rawServices = (d.services ?? d.serviceUuids ?? d.advertisedServices ?? []) as unknown[];
  const services: string[] = rawServices.map((s) => String(s).toLowerCase());
  const rssi = typeof d.rssi === 'number' ? d.rssi : undefined;
  return { address, name, services, rssi, raw: d };
}

/** True if a device looks like a Reachy Mini (by name OR advertised service). */
export function looksLikeReachy(d: BleDevice): boolean {
  if (d.name && REACHY_NAME_RE.test(d.name)) return true;
  // Match our command/status service UUIDs even when the name is absent
  // (common on Android: name lives in the scan response, often null here).
  return d.services?.some((s) => s.includes('cdef0') || s.includes('cdef3')) ?? false;
}

/**
 * Keep only Reachy Minis and order them strongest-signal-first.
 *
 * RSSI is negative dBm (closer to 0 = stronger / nearer), so we sort
 * descending. Devices without an RSSI sink to the bottom rather than
 * jumping to the top of the list.
 */
export function reachyBySignal(devices: BleDevice[]): BleDevice[] {
  const rssiOf = (d: BleDevice): number => (typeof d.rssi === 'number' ? d.rssi : -Infinity);
  return devices.filter(looksLikeReachy).sort((a, b) => rssiOf(b) - rssiOf(a));
}

// The blec plugin owns a SINGLE global scanner. Two overlapping scans
// therefore fight over it: a stale scan's trailing stopScan() would kill a
// newer one, so a rescan triggered before the previous window elapsed (wizard
// remount, retry(), a connection drop bouncing back to 'scanning') silently
// fails to re-trigger. Each scanDevices() call claims a token; only the latest
// token is allowed to stop the scanner.
let _scanToken = 0;

/**
 * Scan and return ALL discovered devices (deduped by address). The UI lists
 * them so you can tap the robot directly — robust even when the advertised
 * name is null in the scan callback. `onUpdate` fires on each scan tick.
 */
export async function scanDevices(
  timeoutMs = 15000,
  onUpdate?: (devices: BleDevice[]) => void,
  log: (s: string) => void = () => {},
): Promise<BleDevice[]> {
  const myToken = ++_scanToken;

  // The plugin's check_permissions ALSO triggers the Android runtime
  // permission request when not yet granted, returning false immediately
  // (the grant is async). First Scan shows the dialog; approve, Scan again.
  const granted = await checkPermissions();
  log(`permissions granted = ${granted}`);
  if (!granted) {
    throw new Error(
      'Bluetooth permission not granted yet — approve the "Nearby devices" ' +
        'dialog, then tap Scan again.',
    );
  }

  // Make sure no previous scan is still occupying the single global scanner
  // before we start ours, then give the plugin a moment to settle.
  try {
    await stopScan();
    await new Promise((r) => setTimeout(r, 120));
  } catch {
    /* nothing was scanning */
  }

  const byAddr = new Map<string, BleDevice>();
  let ticks = 0;
  // The channel may deliver an array of devices, a single device, or a
  // `{ result: device }` wrapper depending on platform/version — accept all.
  const handler = (msg: unknown) => {
    ticks++;
    const list: unknown[] = Array.isArray(msg)
      ? msg
      : msg && typeof msg === 'object' && 'result' in msg
        ? [(msg as { result: unknown }).result]
        : msg
          ? [msg]
          : [];
    for (const raw of list) {
      const d = normalizeDevice(raw as Record<string, unknown>);
      if (d.address) byAddr.set(d.address, d);
    }
    log(`  tick ${ticks}: ${byAddr.size} device(s) total`);
    onUpdate?.([...byAddr.values()]);
  };

  log(`scanning ${timeoutMs}ms…`);
  // CRITICAL: startScan RESOLVES IMMEDIATELY (it kicks off a background scan
  // that auto-stops after `timeout`; devices stream in via the channel). We
  // must keep collecting for the window — NOT stop right away, which was
  // killing the scan ~0ms in.
  await startScan(handler, timeoutMs);
  await new Promise((r) => setTimeout(r, timeoutMs));
  // A newer scan claimed the scanner while we were waiting — leave it alone,
  // otherwise we'd stop the fresh scan the user just asked for.
  if (myToken !== _scanToken) {
    log('superseded by a newer scan — not stopping it');
    return [...byAddr.values()];
  }
  try {
    await stopScan();
  } catch {
    /* already auto-stopped by the plugin */
  }
  // IMPORTANT: this plugin (0.4.x) DROPS any device whose name is null in the
  // scan record (Kotlin `sendResult`: `if (name == null) return`). So a device
  // the OS shows by name can still be invisible here if its name rides only in
  // the scan response and wasn't captured. If the robot never appears but other
  // NAMED devices do, that's this drop — not a permission problem.
  log(`scan done: ${byAddr.size} named device(s) seen over ${ticks} tick(s)`);
  return [...byAddr.values()];
}

export interface ScanController {
  /** Stop the continuous scan loop and release the scanner (best-effort). */
  stop: () => Promise<void>;
}

// Continuous-scan tuning. Each cycle re-arms the plugin's single-shot scanner
// for `WINDOW_MS`; a device not re-seen within `STALE_MS` (≈2 windows) is
// pruned so a powered-off / carried-away robot drops out of the live list.
// `PRUNE_MS` re-emits between ticks so stale entries disappear even when no
// new advertisements arrive.
const CONT_SCAN_WINDOW_MS = 5_000;
const CONT_SCAN_STALE_MS = 11_000;
const CONT_SCAN_PRUNE_MS = 2_000;

/**
 * Continuously scan for BLE devices until `stop()` is called.
 *
 * Unlike {@link scanDevices} (one fixed window that then freezes), this re-arms
 * the plugin's single-shot scanner in a loop and streams a LIVE list via
 * `onUpdate`: new robots appear within a window, and a robot that goes away is
 * pruned after `staleAfterMs`. Built to back a "looking for Reachies" view that
 * stays fresh the whole time it is on screen — the caller restarts it on
 * refocus (mobile kills BLE scans when the app is backgrounded) and MUST call
 * `stop()` before connecting (the radio can't scan and connect at once).
 *
 * Shares the global `_scanToken` with {@link scanDevices}: starting any newer
 * scan supersedes this loop, which then exits without fighting over the single
 * plugin scanner.
 */
export function startContinuousScan(opts: {
  onUpdate: (devices: BleDevice[]) => void;
  onError?: (err: Error) => void;
  windowMs?: number;
  staleAfterMs?: number;
  log?: (s: string) => void;
}): ScanController {
  const windowMs = opts.windowMs ?? CONT_SCAN_WINDOW_MS;
  const staleAfterMs = opts.staleAfterMs ?? CONT_SCAN_STALE_MS;
  const log = opts.log ?? (() => {});
  const myToken = ++_scanToken;
  let stopped = false;

  const seen = new Map<string, { device: BleDevice; ts: number }>();

  const emit = (): void => {
    const cutoff = Date.now() - staleAfterMs;
    for (const [addr, e] of seen) {
      if (e.ts < cutoff) seen.delete(addr);
    }
    opts.onUpdate([...seen.values()].map((e) => e.device));
  };

  const handler = (msg: unknown): void => {
    const list: unknown[] = Array.isArray(msg)
      ? msg
      : msg && typeof msg === 'object' && 'result' in msg
        ? [(msg as { result: unknown }).result]
        : msg
          ? [msg]
          : [];
    const now = Date.now();
    for (const raw of list) {
      const d = normalizeDevice(raw as Record<string, unknown>);
      if (d.address) seen.set(d.address, { device: d, ts: now });
    }
    emit();
  };

  const pruneTimer = setInterval(emit, CONT_SCAN_PRUNE_MS);

  void (async () => {
    const granted = await checkPermissions();
    if (!granted) {
      stopped = true;
      clearInterval(pruneTimer);
      opts.onError?.(
        new Error(
          'Bluetooth permission not granted yet — approve the "Nearby devices" ' +
            'dialog, then scan again.',
        ),
      );
      return;
    }
    log('continuous scan started');
    while (!stopped && myToken === _scanToken) {
      // Clear any prior/auto-stopped window before re-arming, then settle.
      try {
        await stopScan();
        await new Promise((r) => setTimeout(r, 80));
      } catch {
        /* nothing was scanning */
      }
      if (stopped || myToken !== _scanToken) break;
      try {
        // startScan resolves immediately and auto-stops after windowMs; we
        // wait the window out, then loop to re-arm.
        await startScan(handler, windowMs);
      } catch (e) {
        opts.onError?.(e as Error);
        break;
      }
      await new Promise((r) => setTimeout(r, windowMs));
    }
    clearInterval(pruneTimer);
    if (myToken === _scanToken) {
      try {
        await stopScan();
      } catch {
        /* already auto-stopped */
      }
    }
    log('continuous scan loop exited');
  })();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(pruneTimer);
      // Only release the scanner if a newer scan hasn't already claimed it.
      if (myToken === _scanToken) {
        try {
          await stopScan();
        } catch {
          /* fine */
        }
      }
    },
  };
}

/** Reject a promise if it doesn't settle within `ms` (so no step hangs silently). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

let _connWatchStarted = false;
// The latest connection-state handler. The plugin's getConnectionUpdates is
// registered ONCE (calling it again would double-register), but callers — the
// setup wizard in particular — hand us a fresh callback bound to the current
// React mount every time they mount. We dispatch to whatever's latest here, so
// a 2nd+ wizard entry still gets live BLE-drop detection instead of a dead,
// stale closure from the first mount.
let _connHandler: ((connected: boolean) => void) | null = null;

/**
 * Register the plugin's real connection-state signal. Drives the UI
 * `connected` flag from the truth — the plugin's own `connect()` swallows
 * errors and resolves regardless, so it can't be trusted to report success.
 *
 * The underlying plugin subscription is installed once; subsequent calls just
 * swap in the newest handler (see `_connHandler`).
 */
export async function watchConnection(
  onState: (connected: boolean) => void,
  log: (s: string) => void = () => {},
): Promise<void> {
  _connHandler = onState;
  if (_connWatchStarted) return;
  _connWatchStarted = true;
  await getConnectionUpdates((connected: boolean) => {
    log(`connection state → ${connected}`);
    if (!connected) _subscribed = false;
    _connHandler?.(connected);
  });
}

/**
 * Connect to a device and subscribe to RESPONSE notifications.
 *
 * Every step is logged and time-bounded: `blecConnect` swallows its own
 * errors (so a failed GATT connect would otherwise look like success and
 * then hang at subscribe), and a stuck CCCD write must not wedge the flow.
 */
export async function connect(
  address: string,
  log: (s: string) => void = () => {},
): Promise<void> {
  log(`connecting to ${address}…`);
  await withTimeout(
    blecConnect(address, () => {
      log('plugin reported disconnect');
      _subscribed = false;
    }),
    15000,
    'connect',
  );
  log('blecConnect returned; subscribing…');
  if (!_subscribed) {
    try {
      await withTimeout(subscribeString(RESP_CHAR, _onNotification), 8000, 'subscribe');
      _subscribed = true;
      log('subscribed to RESPONSE notifications');
    } catch (e) {
      // Non-fatal: synchronous-reply commands still work; only the async
      // WIFI_* results need the subscription. Surface it rather than hang.
      log(`subscribe failed (continuing): ${(e as Error).message ?? e}`);
    }
  }
}

export async function disconnect(): Promise<void> {
  _subscribed = false;
  try {
    await blecDisconnect();
  } catch {
    /* already disconnected */
  }
}

/**
 * Write a command and return the robot's reply.
 *
 * Reads the synchronous reply on RESPONSE; if it is the `OK: working` ack
 * (every WiFi command), awaits the follow-up notification carrying the real
 * payload. `PING`/`PIN_…` reply synchronously and return immediately.
 */
export async function sendCommand(cmd: string, timeoutMs = 20000): Promise<string> {
  // Start each command from a clean slate. A FAST async command (WIFI_KEYEX,
  // WIFI_STATUS) can have its result notification fire BEFORE our sync read
  // grabs it: the read then returns the real payload (so the command itself
  // succeeds), but the notification orphans in the backlog. Left there, the
  // NEXT command's `_awaitNotification` would shift out that stale entry
  // instead of waiting for its own result — which is exactly how WIFI_SCAN was
  // silently getting served the prior WIFI_KEYEX object and returning []. Any
  // notification still queued when a new command begins is stale by definition.
  if (_notifBacklog.length) {
    _log(`drop ${_notifBacklog.length} stale notif(s): ${JSON.stringify(_notifBacklog)}`);
    _notifBacklog.length = 0;
  }
  const cmdBytes = new TextEncoder().encode(cmd).length;
  _log(`TX → ${_redactCmd(cmd)} (${cmdBytes}B)`);
  // Bound the write AND the synchronous read. Only the notification await below
  // was timed out before, so a wedged write/read here hung the caller forever
  // (e.g. the wizard stuck on "Linking"). 8s is generous for a local op.
  await withTimeout(sendString(CMD_CHAR, cmd), 8000, `write ${_redactCmd(cmd)}`);
  const sync = (await withTimeout(readString(RESP_CHAR), 8000, 'read RESPONSE')).trim();
  _log(`RX sync ← ${JSON.stringify(sync)} (${sync.length}B)`);
  if (sync === WORKING_ACK) {
    const payload = await _awaitNotification(timeoutMs);
    _log(`RX result ← ${JSON.stringify(payload)} (${payload.length}B)`);
    return payload;
  }
  return sync;
}

/**
 * Read a read-only status characteristic (e.g. HARDWARE_ID, NETWORK_STATUS).
 * Time-bounded so a quiet GATT stack can't wedge the wizard. Returns the
 * trimmed UTF-8 value, or throws on timeout / read error.
 */
export async function readCharacteristic(uuid: string, timeoutMs = 6000): Promise<string> {
  const raw = await withTimeout(readString(uuid), timeoutMs, `read ${uuid}`);
  const v = raw.trim();
  _log(`RX read ${uuid.slice(-4)} ← ${JSON.stringify(v)} (${v.length}B)`);
  return v;
}

// ─── Crypto: seal the WiFi password (mirror of the daemon) ───────────────────
/**
 * Build the `WIFI_CONNECT_ENC` command string with the password sealed.
 *
 * `keyexJson` is the raw `WIFI_KEYEX` reply: `{kid, pk, alg}` where `pk` is the
 * base64 of the robot's ephemeral X25519 public key. `pin` is the device PIN
 * (also typed for `PIN_…` auth) — it is the HKDF salt, which authenticates the
 * channel without any OS BLE pairing.
 */
export function buildSealedConnect(
  ssid: string,
  psk: string,
  pin: string,
  keyexJson: string,
): string {
  const keyex = JSON.parse(keyexJson) as { kid: string; pk: string; alg?: string };
  const robotPub = b64ToU8(keyex.pk);
  if (robotPub.length !== 32) throw new Error('bad robot public key length');

  // Ephemeral X25519 keypair (any 32 random bytes is a valid scalar; @noble
  // clamps internally). ECDH → shared secret.
  const myPriv = crypto.getRandomValues(new Uint8Array(32));
  const myPub = x25519.getPublicKey(myPriv);
  const shared = x25519.getSharedSecret(myPriv, robotPub);

  // key = HKDF-SHA256(shared, salt=PIN, info=label, 32). Identical on the daemon.
  const key = hkdf(sha256, shared, new TextEncoder().encode(pin), HKDF_INFO, 32);

  // AES-256-GCM, AAD = ssid (binds the sealed PSK to its network). @noble's
  // gcm appends the 16-byte tag to the ciphertext, matching Python AESGCM.
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ssidBytes = new TextEncoder().encode(ssid);
  const ct = gcm(key, nonce, ssidBytes).encrypt(new TextEncoder().encode(psk));

  const blob = {
    ssid,
    kid: keyex.kid,
    epk: u8ToB64(myPub),
    nonce: u8ToB64(nonce),
    ct: u8ToB64(ct),
  };
  return 'WIFI_CONNECT_ENC ' + JSON.stringify(blob);
}
