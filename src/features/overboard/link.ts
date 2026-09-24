import type { OverboardDrive, OverboardLinkStats, OverboardMode } from './types';

/** Common surface of both command paths (WebRTC relay / direct BLE). */
export interface OverboardLink {
  readonly mode: OverboardMode;
  send(drive: OverboardDrive): void;
  getStats(): OverboardLinkStats;
  dispose(): void;
}

export function emptyStats(): OverboardLinkStats {
  return { sent: 0 };
}
