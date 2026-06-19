# BLE scan architecture & hardening

Status: **proposed** (scope agreed, not yet implemented). Owner: `@tfrere`.
Lives in `src/features/ble/`.

The BLE scan is the heart of how a Reachy Mini is set up: the phone is the
BLE central, it discovers nearby robots, the user taps one, and the Wi-Fi
provisioning flow takes over. This document records how that scan works
today, what we want certainty about, how comparable open-source projects
solve the same problem, and the (deliberately scoped) plan to make our
core testable.

**Relevant files:**

- `src/features/ble/bleWifi.ts` - the whole BLE client (transport + scan +
  crypto) today
- `src/features/ble-provisioning/useSetupMachine.ts` - setup wizard FSM,
  consumes the continuous scan
- `src/ui/screens/BleUpdateScreen.tsx` - the "Update over Bluetooth" tool,
  also consumes the continuous scan

## Current architecture

```
radio (Android/iOS)
      │
tauri_plugin_blec  (Rust, THIRD-PARTY: @mnlphlp/plugin-blec)
      │  streams raw scan results to JS
      ▼
bleWifi.ts  (our logic: parse + dedup + staleness + RSSI sort)
      │
      ├── useSetupMachine (wizard)
      └── BleUpdateScreen (BLE updater)
```

The Rust side of this app is deliberately thin (see
`src-tauri/src/lib.rs`): it only proxies HTTP, returns local IPs, and runs
the OAuth bridge. BLE transport comes from the third-party
`tauri_plugin_blec` plugin. Therefore **all the discovery logic we own
lives in JS**, on top of a plugin whose callback shape varies by version.

### The continuous scan

`startContinuousScan()` in `bleWifi.ts` re-arms the plugin's single-shot
scanner in a loop and streams a live list via `onUpdate`:

- **Dedup** by device address (a `Map`).
- **Staleness**: each entry carries a last-seen timestamp; entries older
  than `CONT_SCAN_STALE_MS` (~11 s, ≈2 windows) are pruned so a
  powered-off / carried-away robot drops out. A `PRUNE_MS` timer re-emits
  between ticks so stale entries vanish even with no new advertisements.
- **Supersession**: a module-global `_scanToken` (a generation counter)
  ensures a stale scan's trailing `stopScan()` cannot kill a newer scan -
  this is the classic *fencing token* pattern.
- **Filter + sort**: consumers map the raw list through `reachyBySignal()`
  (keep Reachy Minis, strongest RSSI first; missing RSSI sinks to bottom).

## What we want certainty about

1. We **never display a stale robot** (pruning is correct).
2. **Dedup** by address is correct (same robot never listed twice).
3. The **plugin message-shape tolerance** is correct (`address|id|uuid`,
   `{result}` wrapper, name in scan response, array vs single vs null).
4. **Filter + sort** behave (only Reachy, strongest first).

## Problem: the critical logic is not testable today

The dedup + staleness lives inside the `startContinuousScan` closure
(`seen` Map + `emit()`), so it cannot be unit-tested. There is also
duplication: the plugin-message parsing is copied between `scanDevices`
and `startContinuousScan`, and the React orchestration (scan loop + rescan
on refocus + stop-before-connect) is reimplemented in both consumers.

## Prior art: how OSS tests this block

- **Home Assistant (`habluetooth` / `BluetoothManager`)** is the strongest
  reference for exactly this problem (aggregate BLE advertisements from
  multiple scanners, dedup, mark "unavailable" what stops advertising).
  Key lessons, all of which we already mirror or plan to:
  - A **manager/registry** as the source of truth, **separate from the
    scanners (transport)** - see `homeassistant/components/bluetooth/manager.py`.
  - **Staleness via explicit timeouts**: `UNAVAILABLE_TRACK_SECONDS = 300`
    plus `FALLBACK_MAXIMUM_STALE_ADVERTISEMENT_SECONDS` and a watchdog
    (`SCANNER_WATCHDOG_INTERVAL/TIMEOUT`) in `const.py`.
  - **Tests never touch the radio**: they inject synthetic advertisements
    into the registry and advance a **fake clock** to assert
    seen -> unavailable transitions.
  - Cautionary tale: HA issue #130432 - a rogue scanner stored timestamps
    in **milliseconds instead of seconds**, so entries never expired and
    "polluted the whole stack". A unit test with an injected clock catches
    exactly this class of bug.
- **bleak (`BleakScanner`)**: keeps `seen_devices: dict[str, (BLEDevice,
  AdvertisementData)]` - an **address-keyed map of the most recent
  advertisement**, with the explicit rule "must be cleared when scanning
  starts". Same shape as our dedup + clear-on-(re)start.
- **bleak** also notes dedup depends on the OS (BlueZ dedups, Windows
  does not) - which is why dedup belongs in our layer, not the plugin's.
- **noble / react-native-ble-plx**: only stream `discover` /
  `startDeviceScan`; the consumer maintains its own Map. Most apps on top
  of these libs have **no tests** on their scan loop.
- **Injectable clock for testable timeouts** is a general pattern, e.g.
  Kubernetes `k8s.io/utils/clock` (`Clock` interface + `FakeClock`) used
  throughout its controllers to test expiry loops without sleeping.

## Decision

Keep the logic **in JS** and test the **pure core** there. Considered and
rejected:

- **Native Rust rewrite** (own the BLE scan in `src-tauri`, test with
  `#[cfg(test)]`): over-engineering for our scale and breaks the repo's
  "thin Rust" philosophy; we would have to fork/maintain a cross-platform
  hardware crate. The message-shape variance we most need to test is an
  artifact of the JS<->plugin bridge anyway.
- **Shared `useReachyScan` hook** to de-duplicate the two consumers: real
  DRY value, but it serves duplication-reduction, not the "certainty"
  goal, and it touches the setup FSM (risk). Deferred.

This matches what the strongest OSS reference (Home Assistant) actually
does - a pure registry + injected clock + synthetic advertisements - at a
smaller, proportional scale.

## Plan (agreed scope)

Extract a pure, transport-free, clock-free core and cover it with
deterministic unit tests. No consumer changes.

1. New `src/features/ble/bleScanCore.ts` (pure; no plugin, no `Date.now()`):
   - `interface BleDevice` (moved from `bleWifi.ts`).
   - `normalizeDevice(d)` (moved, exported): `address|id|uuid`,
     `name|localName`, services lowercased, rssi `number | undefined`.
   - `parseScanMessage(msg): BleDevice[]` - factor out the array /
     `{result}` / single-object / null normalization shared today.
   - `looksLikeReachy(d)` and `reachyBySignal(devices)` (moved).
   - `createScanRegistry(staleAfterMs): { ingest(devices, now), live(now) }`
     - dedup by address with an **injected** timestamp; prune entries
     `< now - staleAfterMs`. Deterministic tests, no fake timers.
2. Rewire `bleWifi.ts`: `scanDevices` and `startContinuousScan` use
   `parseScanMessage` + the registry (`emit()` becomes
   `onUpdate(registry.live(Date.now()))`). `bleWifi.ts` re-exports
   `BleDevice`, `looksLikeReachy`, `reachyBySignal` so existing imports
   from `@/features/ble/bleWifi` keep working.
3. New `src/features/ble/bleScanCore.test.ts`:
   - `parseScanMessage`: array, `{result}`, single object, null/undefined
     -> `[]`, id/uuid fallback, name via localName, services lowercased.
   - `looksLikeReachy`: name "ReachyMini" true; service UUID containing
     `cdef0`/`cdef3` true; name null + service match true; neither false.
   - `reachyBySignal`: filters non-Reachy; sorts RSSI descending; missing
     RSSI sinks to the bottom.
   - `createScanRegistry`: ingesting the same address twice does not
     duplicate and refreshes `ts`; `live()` prunes entries past
     `staleAfterMs` (with injected `now`) and keeps in-window entries.
4. Verify: `tsc --noEmit`, lint, and `vitest run` green.

### Deferred (out of scope)

- A shared `useReachyScan({ enabled })` hook to unify the wizard and the
  BLE updater (scanCtrlRef + refocus rescan + stop-before-connect). To be
  done later, once the core tests are green as a safety net.
- Bounded retry in the continuous loop on non-permission scan errors
  (today such an error stops the loop until a manual rescan / refocus).
