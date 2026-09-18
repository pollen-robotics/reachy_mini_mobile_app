/**
 * Client side of the daemon's BLE maintenance commands, as exposed by the
 * "Bluetooth tools" hub (`ui/screens/BleToolsScreen.tsx`).
 *
 * Wire shapes (from the daemon's `bluetooth_service.py`):
 *   PING            → "PONG"                                   (public)
 *   JOURNAL_START   → "OK: Journal streaming started"
 *                     | "OK: Journal already streaming" | "ERROR: …"   (public)
 *   JOURNAL_READ    → up to 480 chars of buffered `journalctl -f` text, drained
 *                     on read; "" when nothing new; "ERROR: Journal not running"
 *   JOURNAL_STOP    → "OK: Journal streaming stopped"          (public)
 *   CMD_<NAME>      → runs `commands/<NAME>.sh` with sudo. Needs the `connected`
 *                     flag from a prior `PIN_…`, and RESETS it after every run
 *                     (re-auth before each script). "ERROR: …" on failure.
 *
 * Read-only characteristic:
 *   AVAILABLE_COMMANDS (cdef6) → "HOTSPOT, RESTART_DAEMON, …" | "None"
 *
 * `CMD_` has a robot-side quirk worth spelling out: the handler BLOCKS until
 * the script finishes (HOTSPOT.sh sleeps 5 s then restarts the daemon) and on
 * success returns no reply string at all (falls through as None, which makes
 * the GATT write itself fail with a D-Bus error). Seen from the phone, the
 * write fails or times out (`sendCommand` bounds it at 8 s) and/or the sync
 * read returns the STALE previous reply (`OK: Connected` from the PIN_ we
 * just sent). So only an explicit `ERROR: …` reply means failure; any other
 * reply means "dispatched", and a transport error is settled by a `PING`:
 * link still up → the script ran, link gone → the caller decides.
 */

import { AVAILABLE_COMMANDS_CHAR, readCharacteristic, sendCommand } from '@/features/ble/bleWifi';

/** A daemon reply starting with "ERROR:" - everything else is a payload. */
function isError(reply: string): boolean {
  return reply.trim().toUpperCase().startsWith('ERROR');
}

/** Max chars the daemon returns per `JOURNAL_READ`. */
export const JOURNAL_CHUNK_CHARS = 480;

/**
 * True when a `JOURNAL_READ` chunk looks full, i.e. the robot-side buffer is
 * probably still draining and the caller should read again right away
 * instead of waiting a poll interval. `sendCommand` trims the reply, so a
 * full chunk ending in a newline comes back a few chars short of 480 - hence
 * the small tolerance rather than an exact match.
 */
export function isFullJournalChunk(chunk: string): boolean {
  return chunk.length >= JOURNAL_CHUNK_CHARS - 8;
}

/** `PING` → true on `PONG`. Throws on a transport error (link gone). */
export async function ping(): Promise<boolean> {
  const r = await sendCommand('PING', 8000);
  return r.trim().toUpperCase() === 'PONG';
}

/** `JOURNAL_START` → starts the server-side `journalctl -f` buffer. */
export async function journalStart(): Promise<void> {
  const r = await sendCommand('JOURNAL_START', 8000);
  if (isError(r)) throw new Error(r);
}

/**
 * `JOURNAL_READ` → the next chunk of buffered log text ('' when nothing new).
 * Throws on `ERROR: Journal not running` (caller restarts the stream once).
 */
export async function journalRead(): Promise<string> {
  const r = await sendCommand('JOURNAL_READ', 8000);
  if (isError(r)) throw new Error(r);
  return r;
}

/** `JOURNAL_STOP` - best-effort, never throws (the robot also stops on disconnect). */
export async function journalStop(): Promise<void> {
  try {
    await sendCommand('JOURNAL_STOP', 8000);
  } catch {
    // non-critical: ignore
  }
}

/**
 * Parse the AVAILABLE_COMMANDS characteristic: comma-separated script names,
 * or the literal "None" when the robot has no `commands/*.sh`.
 */
export function parseAvailableCommands(raw: string | null): string[] {
  const names = (raw ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0 && s.toLowerCase() !== 'none');
  return Array.from(new Set(names));
}

/** Read AVAILABLE_COMMANDS (cdef6). Best-effort: [] on read failure / "None". */
export async function readAvailableCommands(): Promise<string[]> {
  try {
    return parseAvailableCommands(await readCharacteristic(AVAILABLE_COMMANDS_CHAR));
  } catch {
    return [];
  }
}

/** Outcome of a `CMD_<NAME>` reply, see {@link interpretScriptReply}. */
export type ScriptVerdict = { ok: true } | { ok: false; message: string };

/**
 * Decide whether a `CMD_` reply means the script was dispatched. Per the
 * quirk in the header: only `ERROR: …` is a failure; an `ECHO:` means the
 * firmware predates scripting; a stale `OK: Connected`, an empty string or
 * anything else means the script ran (the robot never acks success).
 */
export function interpretScriptReply(reply: string): ScriptVerdict {
  const r = reply.trim();
  if (isError(r)) {
    return {
      ok: false,
      message: r.replace(/^ERROR:\s*/i, '').trim() || 'The robot refused the command.',
    };
  }
  if (r.toUpperCase().startsWith('ECHO')) {
    return { ok: false, message: "This robot's software is too old to run maintenance scripts." };
  }
  return { ok: true };
}

/**
 * `CMD_<name>` → resolves once the script is dispatched. Throws on an explicit
 * `ERROR: …` / `ECHO:` reply, or on a transport error when the link turns out
 * to be gone (a follow-up `PING` gets no `PONG`). The caller MUST re-run
 * `PIN_` right before this (the flag is single-use).
 */
export async function runScript(name: string): Promise<void> {
  let reply: string;
  try {
    reply = await sendCommand(`CMD_${name}`, 8000);
  } catch (e) {
    // Write failed or blocked past our bound (see header): the script most
    // likely ran. Settle it with a PING - a live link means the robot is
    // there and reached the script; a dead one is the caller's call.
    try {
      if (await ping()) return;
    } catch {
      /* fall through */
    }
    throw e instanceof Error ? e : new Error(String(e));
  }
  const verdict = interpretScriptReply(reply);
  if (!verdict.ok) throw new Error(verdict.message);
}
