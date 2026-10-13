/**
 * Reachy-only scan, filtered by the OS scanner, so Android doesn't run the
 * plugin's main-thread callback for every nearby device. Swap for the package's
 * `startScan` once it takes `services` upstream (see `src-tauri/vendor`).
 */
import { Channel, invoke } from '@tauri-apps/api/core';

/** The service every Reachy Mini puts in its advertisement (daemon `bluetooth_service.py`). */
const REACHY_ADVERTISED_SERVICE = '12345678-1234-5678-1234-56789abcdef3';

export async function startReachyScan(handler: (devices: unknown) => void, timeout: number): Promise<void> {
  const onDevices = new Channel<unknown>();
  onDevices.onmessage = handler;
  await invoke('plugin:blec|scan', {
    timeout,
    onDevices,
    allowIbeacons: false,
    services: [REACHY_ADVERTISED_SERVICE],
  });
}
