/**
 * Bring a stopped robot daemon back up before waiting on central.
 *
 * A stopped daemon has no media stack, so its central signalling relay never
 * registers and the robot stays invisible to central however well the Hugging
 * Face sign-in went. The desktop app leaves exactly that behind: closing its
 * window POSTs `/api/daemon/stop` to the robot. Without this nudge the setup
 * wizard waits out its central timeout and the only cure is a robot reboot.
 */
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

const STATUS_TIMEOUT_MS = 5_000;
const START_TIMEOUT_MS = 5_000;

/**
 * Best-effort: POST `/api/daemon/start` when the daemon is not already up.
 *
 * `wake_up=false` keeps the robot still — the relay comes up with the media
 * stack either way. Never throws: the caller's central poll decides the
 * outcome, and `probeDaemonFault` explains a daemon that stayed down.
 */
export async function ensureDaemonRunning(ip: string): Promise<void> {
  try {
    const resp = await tauriFetch(`http://${ip}:8000/api/daemon/status`, {
      method: 'GET',
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!resp.ok) return;
    const { state } = (await resp.json()) as { state?: string };
    if (state === 'running' || state === 'starting') return;
    await tauriFetch(`http://${ip}:8000/api/daemon/start?wake_up=false`, {
      method: 'POST',
      signal: AbortSignal.timeout(START_TIMEOUT_MS),
    });
  } catch {
    // Best-effort by design.
  }
}
