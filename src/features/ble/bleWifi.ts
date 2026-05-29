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

function _onNotification(text: string): void {
  const t = text.trim();
  if (_notifResolve) {
    const r = _notifResolve;
    _notifResolve = null;
    r(t);
  } else {
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

function normalizeDevice(d: any): BleDevice {
  // Different plugin versions use address|id|uuid and name|localName.
  const address = d.address ?? d.id ?? d.uuid ?? '';
  const name = d.name ?? d.localName ?? null;
  const services: string[] = (d.services ?? d.serviceUuids ?? d.advertisedServices ?? [])
    .map((s: any) => String(s).toLowerCase());
  return { address, name, services, rssi: d.rssi, raw: d };
}

/** True if a device looks like a Reachy Mini (by name OR advertised service). */
export function looksLikeReachy(d: BleDevice): boolean {
  if (d.name && REACHY_NAME_RE.test(d.name)) return true;
  // Match our command/status service UUIDs even when the name is absent
  // (common on Android: name lives in the scan response, often null here).
  return d.services?.some((s) => s.includes('cdef0') || s.includes('cdef3')) ?? false;
}

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

  const byAddr = new Map<string, BleDevice>();
  let ticks = 0;
  // The channel may deliver an array of devices, a single device, or a
  // `{ result: device }` wrapper depending on platform/version — accept all.
  const handler = (msg: any) => {
    ticks++;
    const list: any[] = Array.isArray(msg)
      ? msg
      : msg && msg.result
        ? [msg.result]
        : msg
          ? [msg]
          : [];
    for (const raw of list) {
      const d = normalizeDevice(raw);
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

/**
 * Register the plugin's real connection-state signal ONCE. Drives the UI
 * `connected` flag from the truth — the plugin's own `connect()` swallows
 * errors and resolves regardless, so it can't be trusted to report success.
 */
export async function watchConnection(
  onState: (connected: boolean) => void,
  log: (s: string) => void = () => {},
): Promise<void> {
  if (_connWatchStarted) return;
  _connWatchStarted = true;
  await getConnectionUpdates((connected: boolean) => {
    log(`connection state → ${connected}`);
    if (!connected) _subscribed = false;
    onState(connected);
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
  await sendString(CMD_CHAR, cmd);
  const sync = (await readString(RESP_CHAR)).trim();
  if (sync === WORKING_ACK) {
    return _awaitNotification(timeoutMs);
  }
  return sync;
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
