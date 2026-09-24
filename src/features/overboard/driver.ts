/**
 * Fixed-rate drive loop: samples the joystick, maps it to a drive
 * command and pushes it to whichever link is active.
 *
 * While the stick is deflected, a changed command goes out on the next
 * tick (≤ 10 Hz) and an unchanged one is repeated every
 * `HEARTBEAT_MS`: that heartbeat keeps the daemon's deadman (it zeroes
 * the drive 300 ms after the last frame) from firing while the stick is
 * held, and lets it stop the wheels when frames stop arriving (lost
 * link, app killed). On release we send a short burst of explicit STOPs,
 * then go silent.
 */
import { deflectionToDrive, isStop } from './drive-mapping';
import type { OverboardLink } from './link';
import { STOP, type OverboardDrive } from './types';

export const DRIVE_TICK_MS = 100;
// Must stay well under the daemon's 300 ms deadman, Wi-Fi jitter included.
export const HEARTBEAT_MS = 100;
const STOP_BURST = 3;

export class OverboardDriver {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopsLeft = 0;

  constructor(
    private readonly getDeflection: () => { x: number; y: number } | null,
    private readonly getLink: () => OverboardLink | null,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), DRIVE_TICK_MS);
  }

  /** Stop the loop; sends a final STOP burst if the wheels may be moving. */
  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
    if (this.stopsLeft > 0 || this.wasMoving) {
      for (let i = 0; i < STOP_BURST; i++) this.getLink()?.send(STOP);
    }
    this.stopsLeft = 0;
    this.wasMoving = false;
    this.lastSent = null;
  }

  private wasMoving = false;
  private lastSent: OverboardDrive | null = null;
  private lastSentAt = 0;

  /** One loop step. Public for tests. */
  tick(now: number = Date.now()): void {
    const def = this.getDeflection() ?? { x: 0, y: 0 };
    const drive = deflectionToDrive(def.x, def.y);
    const link = this.getLink();
    if (!isStop(drive)) {
      this.wasMoving = true;
      this.stopsLeft = STOP_BURST;
      const same =
        this.lastSent?.linear === drive.linear && this.lastSent?.angular === drive.angular;
      // Half a tick of slack: setInterval jitter (a 99 ms tick) must not
      // push the heartbeat to the next tick, 200 ms after the last frame.
      if (same && now - this.lastSentAt < HEARTBEAT_MS - DRIVE_TICK_MS / 2) return;
      link?.send(drive);
      this.lastSent = drive;
      this.lastSentAt = now;
      return;
    }
    if (this.stopsLeft > 0) {
      this.stopsLeft -= 1;
      this.wasMoving = false;
      this.lastSent = null;
      link?.send(STOP);
    }
  }
}
