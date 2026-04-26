# PR-C — Presence model + typed diagnostics

## Goal

Replace today's two parallel discovery lists (BLE + central poll) with
a unified `RobotPresence` model. Surface typed diagnostics so the empty
state of `ScanScreen` tells the user *why* it's empty.

## Why

- A robot reachable via BLE *and* central registration appears twice
  today, deduplicated by name (fragile).
- `[]` from central is indistinguishable from "central down", "token
  rejected", "robot offline" or "zombie-relay desync". The user sees
  the same muted "no robots" in all four cases.
- Foreground resume and network changes don't trigger a refresh.

## Scope

### Data model

```ts
type Transport = 'ble' | 'lan-http' | 'central-webrtc';

interface RobotIdentity {
  serial: string;
  displayName: string;
  ownerHfHandle?: string;
}

interface TransportProbe {
  transport: Transport;
  status: 'unknown' | 'reachable' | 'degraded' | 'unreachable';
  lastSeenAt?: number;
  latencyMs?: number;
  lastError?: { code: string; message: string };
}

interface RobotPresence {
  identity: RobotIdentity;
  transports: Partial<Record<Transport, TransportProbe>>;
  preferredTransport: Transport | null;
  busy: { holder: 'self' | 'other' | 'unknown'; since: number } | null;
}
```

### `PresenceStore` (Zustand)

Single source of truth. Sources push `TransportProbe` keyed by
`identity.serial`. Store fuses entries; computes `preferredTransport`
by latency rank.

### Sources

- `BleSource` — wraps existing `useBleSession` discovery
- `CentralSource` — replaces `useRemoteRobots`. Adaptive polling
  (1-5s when foreground+empty, 30-60s otherwise). Pre-flight token
  check via `/api/whoami-v2`. Distinguishes `network_error`,
  `timeout`, `token_rejected`, `http_5xx`, `empty_list`.
- `LanHttpSource` — optional, ARP-based, off by default

### Lifecycle hooks

- `visibilitychange` foreground → force refresh all sources
- `online` / `offline` → reset retry timers, update probe statuses
- BLE permission denied → emit a `diagnostic` event surfaced in UI

### UI changes

- `ScanScreen` empty state shows actionable diagnostic
  - "Hugging Face: reachable. 0 robots registered. [Why?]"
  - vs "Hugging Face: unreachable (timeout). Last success: 4 min ago."
  - vs "Token rejected. [Sign in again]"

## Out of scope

- Multi-transport selection at session time (= PR-E)
- Token auto-refresh (= PR-D)
- AppsPanel/Forget Wi-Fi unification (= PR-F)
- SSE from central (depends on upstream HF central change)

## Test plan

- Mock `CentralSource` returning each error class; verify diagnostic
  rendered in UI matches the class
- Toggle airplane mode mid-app; observe `online`/`offline` handling
- Background app → kill central → resume → observe refresh + error
