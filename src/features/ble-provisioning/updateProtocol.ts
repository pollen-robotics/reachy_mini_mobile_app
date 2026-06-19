/**
 * Client side of the daemon's "update over BLE" commands.
 *
 * Mirrors the daemon PR (pollen-robotics/reachy_mini#1172): the BLE service
 * proxies three privileged commands to the daemon's existing `/update/*` HTTP
 * API. All three require a prior `PIN_<pin>` (see `authenticate` in
 * `protocol.ts`); unlike the WiFi commands they do NOT reset the session, so a
 * client can chain check → start → poll without re-authing.
 *
 * Wire shapes (from the PR description):
 *   UPDATE_CHECK         → {"available":bool,"current":"x.y.z","latest":"x.y.z"}
 *   UPDATE_START         → "OK: Update started <job_id>"
 *                          | "ERROR: No update available or already in progress"
 *   UPDATE_INFO <job_id> → {"status":"pending|in_progress|done|failed","lines":N,"last":"<line>"}
 *
 * These all hit the network off the BLE mainloop, so the daemon acks with
 * `OK: working` and the real payload arrives as a later notification — exactly
 * the async path `sendCommand` already handles.
 *
 * NOTE: this is a throwaway test surface, not the eventual clean integration.
 */

import { sendCommand } from '@/features/ble/bleWifi';

/** A daemon reply starting with "ERROR:" - everything else is a payload. */
function isError(reply: string): boolean {
  return reply.trim().toUpperCase().startsWith('ERROR');
}

/** Parsed `UPDATE_CHECK` reply. */
export interface UpdateCheck {
  available: boolean;
  current: string | null;
  latest: string | null;
}

/** Parsed `UPDATE_INFO` reply. */
export interface UpdateInfo {
  status: 'pending' | 'in_progress' | 'done' | 'failed' | string;
  lines: number;
  last: string;
}

/** `UPDATE_CHECK` → whether an update is available + current/latest versions. */
export async function updateCheck(): Promise<UpdateCheck> {
  const r = await sendCommand('UPDATE_CHECK', 20000);
  if (isError(r)) throw new Error(r);
  const parsed = JSON.parse(r) as Partial<UpdateCheck>;
  return {
    available: Boolean(parsed.available),
    current: parsed.current ?? null,
    latest: parsed.latest ?? null,
  };
}

/**
 * `UPDATE_START` → the daemon-assigned job id on success.
 * Throws on `ERROR: No update available or already in progress` (and friends).
 */
export async function updateStart(): Promise<string> {
  const r = await sendCommand('UPDATE_START', 30000);
  if (isError(r)) throw new Error(r);
  // "OK: Update started <job_id>" — take the trailing token as the job id.
  const m = r.trim().match(/started\s+(\S+)\s*$/i);
  if (!m) throw new Error(`Unexpected UPDATE_START reply: ${r}`);
  return m[1];
}

/** `UPDATE_INFO <job_id>` → status + log progress (last line only). */
export async function updateInfo(jobId: string): Promise<UpdateInfo> {
  const r = await sendCommand(`UPDATE_INFO ${jobId}`, 20000);
  if (isError(r)) throw new Error(r);
  const parsed = JSON.parse(r) as Partial<UpdateInfo>;
  return {
    status: parsed.status ?? 'unknown',
    lines: typeof parsed.lines === 'number' ? parsed.lines : 0,
    last: parsed.last ?? '',
  };
}
