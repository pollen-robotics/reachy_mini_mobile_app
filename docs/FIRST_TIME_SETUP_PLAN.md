# First-Time Setup (Wireless) - UX & Implementation Plan

> Status: **proposal / draft** · Target: `reachy_mini_mobile_app` (Tauri 2 + React 19 + MUI 9)
> Author: design study · Last updated: 2026-05-31

## 1. Goal

Let a user provision a **brand-new Reachy Mini Wireless** onto their Wi-Fi
**from the phone, over Bluetooth Low Energy only** - the user never has to
join the robot's Wi-Fi hotspot. Once the robot is on Wi-Fi it registers with
the Hugging Face central signaling Space and becomes reachable through the
existing session flow.

This is the missing onboarding path. Today the app assumes the robot is
*already* on Wi-Fi and registered with central (see the docstring in
`src/App.tsx`).

## 2. Current state (what exists today)

| Layer | State |
|---|---|
| Mobile shell | `Splash → Consent → HF Sign-in → ScanScreen (central listing) → Session (WebRTC)` |
| Native wrapper | **Tauri 2** (iOS/Android/desktop), React 19 + MUI 9, WebView |
| BLE support | **None** - no Tauri BLE plugin, no capability, no native permissions |
| Discovery | Central only (`fetchRobotsFromCentral.ts`, polled with HF token) |
| Daemon BLE | Specified & implemented on branch `feat/ble-wifi-provisioning-v2` (not yet merged to `main`) |

### Reusable design-system assets

- `ui/design/StepsProgressIndicator.tsx` - horizontal stepper with progress bar (perfect for the wizard header).
- `ui/screens/session/ConnectingView.tsx` - illustration + stepper + morphing caption (reuse idiom for the "connecting" step).
- `ui/screens/session/SessionErrorView.tsx` - error layout idiom.
- `ui/design/ScreenTransition.tsx` - `AnimatePresence`-based screen swaps.
- `ui/design/RobotAvatar.tsx`, `ShortId.tsx`, `TransportChip.tsx`, `tokens.ts`.

## 3. Daemon BLE contract (source of truth)

From `feat/ble-wifi-provisioning-v2` (`bluetooth_service.py` + `routers/wifi_config.py`).

### GATT layout

| | UUID | Properties |
|---|---|---|
| Service | `12345678-1234-5678-1234-56789abcdef0` | - |
| Command | `…def1` | `write` |
| Response | `…def2` | `read`, `notify` |
| Network status | `…def4` | `read` (`"OFFLINE"` / `"HOTSPOT …"` / `"CONNECTED …"`) |
| System status | `…def5` | `read` |
| Available commands | `…def6` | `read` |
| **Hardware ID** | `…def7` | `read` (SHA-256 prefix = central's `meta.hardware_id`) |

### Command protocol (write to Command, await Response notification)

| Command | Auth | Reply |
|---|---|---|
| `PING` | public | `PONG` (sync) |
| `PIN_<pin>` | public | `OK: Connected` / `ERROR: Incorrect PIN` - opens a **300 s** session |
| `WIFI_KEYEX` | public | `{kid, pk, alg}` - robot ephemeral X25519 pubkey |
| `WIFI_STATUS` | public* | `{mode, connected, …}` (+ `known` networks only when authed) |
| `WIFI_SCAN` | session | JSON array of SSIDs (one-MTU bounded) or `ERROR: …` |
| `WIFI_CONNECT_ENC <json>` | session | `OK: working` then async result; poll `WIFI_STATUS` for outcome |
| `WIFI_FORGET <ssid>` | session | `OK: …` / `ERROR: …` |

**Async model:** Wi-Fi commands proxy to the daemon and can block (~10 s for
`nmcli rescan`). A write returns an immediate `OK: working` ack; the **real
result arrives as a later Response notification**. Clients MUST: `StartNotify`
→ write → await the next notification.

### Sealed password scheme (`x25519-hkdf-sha256-aesgcm`)

The Wi-Fi password is **never** sent in cleartext (App Store requirement).
BLE pairing is Just-Works (`NoInputNoOutput` hardware → no MITM-protected
pairing), so we encrypt at the application layer and **authenticate the
channel with the device PIN**:

1. `WIFI_KEYEX` → `{kid, pk}` (robot ephemeral X25519 pubkey, base64, rotates ~10 min).
2. Phone generates its own ephemeral X25519 keypair, ECDH against robot key, then
   `key = HKDF-SHA256(ecdh_shared, salt = PIN_utf8, info = "reachy-mini-wifi-psk-v1", L = 32)`.
3. Seal: `AES-256-GCM(key, nonce, plaintext = psk, aad = ssid_utf8)`.
4. Write `WIFI_CONNECT_ENC ` + `{ssid, kid, epk, nonce, ct}` (all base64; `ct = ciphertext||16B tag`).
5. Daemon recomputes ECDH+HKDF (it knows the PIN locally), decrypts, connects via `nmcli`.

- **PIN** = last 5 chars of the device serial (printed on the robot); dev fallback `"46879"`.
- Wrong PIN / tamper → AES-GCM auth fails → daemon `400` → BLE `ERROR: Bad credentials (wrong PIN?)`.
- `AAD = ssid` binds the sealed PSK to its target network.

## 4. Key findings, constraints & risks

### 4.1 ⚠️ The advert carries no identity (BIGGEST design constraint)

In `v2`, **every robot advertises the same `LocalName = "ReachyMini"`** with no
service UUID, no manufacturer data, no provisioned/unprovisioned flag, no hwid,
no IP. (The richer "flag + IP + hwid" advert lives on the *separate*, divergent
branches `robot-identity` / `mobile-app-bluetooth-login-update`, which are not
in `v2`.)

**Consequences for discovery UX:**
- We **cannot** tell from the advert alone which robot needs setup, nor which
  physical robot it is, nor distinguish two robots side by side.
- Strategy: list every `"ReachyMini"` advert, then **after connecting**, read
  `HARDWARE_ID` (def7) + `NETWORK_STATUS` (def4) / `WIFI_STATUS` to learn the
  robot's identity and whether it still needs Wi-Fi.
- For the "central-waiting" handoff we **match the BLE `HARDWARE_ID` against
  `meta.hardware_id`** in the central listing - this is the clean bridge
  between the BLE world and the central world.

> **Decision needed:** either (a) accept "all robots look identical until you
> connect" in v1, or (b) push for the `robot-identity` advert (flag + hwid) to
> land in the daemon branch we target. (a) is shippable now; (b) is the better
> long-term UX.

### 4.2 BLE plugin for Tauri

Tauri 2 has no built-in BLE. Plugin: **`tauri-plugin-blec`** (`btleplug`-based,
native iOS/Android, JS package `@mnlphlp/plugin-blec`).

- An existing prototype branch (`test/bluetooth-wifi-connect`, see §11) already
  integrates it pinned at **0.4** and has a working transport on real hardware.
- Latest line is **0.11.4** (2026-05-19); it may fix the Android null-name scan
  drop (§4.4) but the API may differ. **Decision:** stay on 0.4 for the spike
  (proven), evaluate the 0.11 upgrade afterwards.
- **Risk:** community plugin, MSRV 1.80; validate on real iOS + Android.
- Requires `blec:default` (+ `blec:allow-check-permissions`) in
  `capabilities/default.json`.
- iOS: `NSBluetoothAlwaysUsageDescription` in `Info.plist` + link CoreBluetooth.
- Android: `BLUETOOTH_SCAN` + `BLUETOOTH_CONNECT` (API 31+), and on API ≤ 30 the
  legacy `BLUETOOTH`/`BLUETOOTH_ADMIN` + `ACCESS_FINE_LOCATION` (see existing
  `docs/ANDROID_PERMISSIONS.md`).

### 4.3 Crypto in the WebView

The password sealing needs X25519 ECDH + HKDF-SHA256 + AES-256-GCM **on the
phone, before the BLE write**. **Resolved:** the prototype branch already does
this with `@noble/curves` + `@noble/hashes` + `@noble/ciphers` (tiny, audited,
pure-JS), verified byte-for-byte against the daemon. We avoid the per-platform
WebCrypto-X25519 capability matrix entirely. The `buildSealedConnect()` helper
is reusable almost as-is (see §11).

### 4.4 Other notes

- Session TTL is 300 s; the daemon re-asserts advertising and resets the
  session when the central (phone) disconnects, so a dropped BLE link forces
  re-auth (re-send `PIN_`).
- `WIFI_SCAN` reply is bounded to one MTU (~180 bytes budget) → the SSID list
  can be truncated. Provide a "rescan" and a "hidden network" manual-entry path.
- On a failed connect the daemon **reverts to hotspot** automatically; the app
  should poll `WIFI_STATUS` and surface the revert as a clear failure.

## 5. UX flow

### 5.1 Where it plugs in

```
App.tsx :  type Screen = 'scan' | 'session' | 'setup'        // + 'setup'

[ScanScreen] ── new CTA below the list ──▶ [SetupWizardScreen]
              "+ Set up a new Reachy"                │ onDone(robot)
[ScanScreen] ◀── robot now on central listing ──────┘   (or auto-handoff → Session)
```

- Entry point: a **discrete CTA** ("Set up a new Reachy") in the `ScanScreen`
  bottom action zone, next to `StickyRefreshBar`. BLE only starts on demand
  (no passive scanning, lower battery/permission friction). *(Decided: Option B.)*
- The setup stays **behind the HF sign-in** (the robot needs the account
  anyway). *(Decided.)*

### 5.2 Wizard header (4 perceived phases)

Reuses `StepsProgressIndicator`:

```
   ●━━━━━━━●━━━━━━━○━━━━━━━○
  Pair    Network  Connect  Ready
```

### 5.3 State machine (`useSetupMachine`)

```
permission → ble-scan → ble-connect → pin → auth        [PAIR]
  → wifi-scan → wifi-pick → wifi-password               [NETWORK]
  → wifi-connecting → central-waiting                   [CONNECT]
  → done                                                [READY]
  (error: <reason> from any state, with a TARGETED return step)
```

### 5.4 Screen by screen

**0. CTA (in ScanScreen)**
```
   ────────────────────────
   ↻ Refresh                 ← existing
   + Set up a new Reachy     ← NEW
```

**1. PermissionPrimerStep** - explain before the OS prompt (never prompt cold).
```
   ●━━━○━━━○━━━○   Pair…
        (BLE illu)
   Connect over Bluetooth
   To set up a new Reachy we use Bluetooth
   to send it your Wi-Fi details. Nothing
   leaves your phone in clear.
        [ Continue ]   → triggers OS permission prompt
        Cancel
```
Refusal → soft error with deep-link to OS settings.

**2. BleScanStep** - list every `"ReachyMini"` advert; identity resolved post-connect.
```
   ●━━━○━━━○━━━○   Pair…
   Looking for new Reachies   ⟳ scanning…
   ┌────────────────────────┐
   │ ◌ Reachy            >  │   ← reuse RobotAvatar / card style
   └────────────────────────┘
   Don't see it? Make sure it's powered on. [Help]
```
Tap → GATT connect → read `HARDWARE_ID` + `NETWORK_STATUS`.
(If `NETWORK_STATUS == CONNECTED`, warn "this robot is already online".)

**3. PinStep** - authenticate.
```
   ●━━━●━━━○━━━○   Pair…
   Enter the setup code
   Find the 5-character code printed under your Reachy.
        ┌─┐┌─┐┌─┐┌─┐┌─┐        ← mono "code" input
        [ Verify ]
```
`PIN_<code>` → on `OK: Connected`, immediately `WIFI_KEYEX` (grab robot pubkey).
Wrong PIN → shake + reset; respect the 300 s session + any throttle.

**4. WifiPickStep** - `WIFI_SCAN` (~10 s, async via notification → spinner).
```
   ●━━━●━━━◐━━━○   Network…
   Choose a Wi-Fi network
   ┌────────────────────────┐
   │ Home_5G        🔒      │
   │ Guest          🔒      │
   └────────────────────────┘
   ⟳ Rescan      Join a hidden network ›
```
(Signal strength is not in the SSID-only reply; show lock only if known, else plain.)

**5. WifiPasswordStep** - seal locally before sending.
```
   ●━━━●━━━◐━━━○   Network…
        Home_5G  🔒
   Wi-Fi password
   ┌────────────────────┐ 👁
   │ ••••••••           │
   └────────────────────┘
   🔒 Encrypted on this phone before it's sent
   [ Connect ]
```
Seal via `seal.ts` (`@noble`) → `WIFI_CONNECT_ENC <json>`. Open network → skip this step.

**6. ConnectingStep** - reuse `ConnectingView` idiom; poll `WIFI_STATUS`.
```
   ●━━━●━━━●━━━◐   Connect…
        (connection.svg)
   Connecting your Reachy
   Joining Home_5G…   →   Almost there…   →   Registering with Hugging Face…
```
After `connected`: enter **`central-waiting`** - poll `useRemoteRobots` until a
listing with matching `meta.hardware_id` (the BLE `HARDWARE_ID`) appears.

**7. SuccessStep**
```
   ●━━━●━━━●━━━●   Ready ✓
        (✓ + RobotAvatar)
   <Name> is online!
   [ Open <Name> ]            → RobotSessionScreen
   Back to all Reachies       → ScanScreen
```

**Error (transverse) - SetupErrorStep** (pattern: `SessionErrorView`)

| Daemon / cause | Message | Targeted return |
|---|---|---|
| `ERROR: Incorrect PIN` / `Bad credentials (wrong PIN?)` | Wrong code | → PinStep |
| `ERROR: Busy` (daemon 409) | Robot busy, retry | retry in place |
| Not connected after timeout (reverted to hotspot) | Wrong password? | → WifiPasswordStep |
| `Daemon unreachable` / BLE drop | Connection lost | → BleScanStep (re-auth) |
| OS permission denied | Open settings | deep-link |

## 6. Proposed architecture

> Much of the transport + crypto already exists on `test/bluetooth-wifi-connect`
> as `src/features/ble/bleWifi.ts`. The structure below is the productized
> refactor of that file (encapsulate the module-level globals, split transport
> from crypto, add the FSM). See §11.

```
src/features/ble-provisioning/
  BleTransport.ts        # harvested from bleWifi.ts transport half
                         #   scan(), connect(id), readChar(uuid),
                         #   writeCommand(str), onResponseNotify(cb), disconnect()
                         #   KEEP: notif backlog queue, withTimeout per step,
                         #   getConnectionUpdates as source of truth, scan window
  protocol.ts            # command builders + Response parsing
                         #   ping/pin/keyex/status/scan/connectEnc/forget
                         #   + async "ack then notification" helper (sendCommand)
  seal.ts                # buildSealedConnect() harvested as-is (@noble)
  useSetupMachine.ts     # the FSM hook (phase, transitions, errors, retries)
  types.ts               # SetupPhase, RobotIdentity, WifiNetwork, SetupError

src/ui/screens/setup/
  SetupWizardScreen.tsx  # shell: stepper header + ScreenTransition + cancel/back
  steps/PermissionPrimerStep.tsx
  steps/BleScanStep.tsx
  steps/PinStep.tsx
  steps/WifiPickStep.tsx
  steps/WifiPasswordStep.tsx
  steps/ConnectingStep.tsx
  steps/SuccessStep.tsx
  steps/SetupErrorStep.tsx
```

### Integration points

- `src/App.tsx`: add `'setup'` to `Screen`; render `SetupWizardScreen` when
  active; `onStartSetup` from `ScanScreen` flips the screen; `onDone(robot)`
  either auto-hands to `RobotSessionScreen` or returns to `ScanScreen`.
- `src/ui/screens/ScanScreen.tsx`: add the CTA in the bottom action zone.
- `src-tauri/`: register `tauri_plugin_blec::init()`, add `blec:default`
  capability, `Info.plist` key, Android manifest permissions, CoreBluetooth.

## 7. Native config checklist

- **iOS** `src-tauri/Info.plist`: `NSBluetoothAlwaysUsageDescription`
  ("Reachy Mini uses Bluetooth to set up your robot's Wi-Fi."); link
  CoreBluetooth in the Xcode target.
- **Android** manifest: `BLUETOOTH_SCAN` (with `neverForLocation` if we never
  derive location), `BLUETOOTH_CONNECT`; legacy fallbacks for API ≤ 30. Runtime
  request handled by the plugin / a small wrapper. Cross-check
  `docs/ANDROID_PERMISSIONS.md`.
- **Capability** `src-tauri/capabilities/default.json`: add `"blec:default"`.

## 8. Phased delivery

1. **Spike (de-risk):** mostly DONE on `test/bluetooth-wifi-connect` - the
   transport + crypto already round-trip the full flow on real hardware. Remaining:
   re-validate on the current iOS + Android targets, confirm `HARDWARE_ID` read.
2. **Protocol + crypto:** harvest `bleWifi.ts` into `BleTransport` + `protocol.ts`
   + `seal.ts` (encapsulate the module globals; add unit tests for sealing
   against a known daemon vector). No product UI yet.
3. **FSM + shell:** `useSetupMachine` + `SetupWizardScreen` with placeholder
   steps; wire `App.tsx` + `ScanScreen` CTA.
4. **Happy-path screens:** PermissionPrimer → BleScan → Pin → WifiPick →
   WifiPassword → Connecting → Success.
5. **Error handling + central handoff:** `SetupErrorStep`, `central-waiting`
   hwid match, targeted retries.
6. **Polish:** copy, a11y (`aria-label`, focus), dark mode, motion, hidden
   network, open networks.

## 9. Open questions / decisions

- [ ] **Advert identity:** ship with "all robots identical until connect" (v1),
      or block on landing `robot-identity` (flag + hwid advert) in the daemon?
- [ ] **Target daemon branch:** `v2` vs the soon-to-be-merged successor; confirm
      the endpoint/command names won't shift under us.
- [ ] **Plugin choice:** confirm `tauri-plugin-blec` after the spike, or evaluate
      `tauri-plugin-blew`.
- [ ] **Crypto lib:** `@noble` (recommended) vs WebCrypto X25519.
- [ ] **Post-success:** auto-open the session, or return to the list?
- [ ] **Multi-robot disambiguation** at scan time given the identical advert.

## 10. References

- Daemon: `reachy_mini` @ `feat/ble-wifi-provisioning-v2`
  - `src/reachy_mini/daemon/app/services/bluetooth/bluetooth_service.py`
  - `src/reachy_mini/daemon/app/routers/wifi_config.py`
  - `…/services/bluetooth/BLE_WIFI_PROVISIONING.md` (design + iOS CryptoKit reference client)
- Plugin: https://github.com/MnlPhlp/tauri-plugin-blec
- Existing docs: `docs/ANDROID_PERMISSIONS.md`, `docs/APP_STORE_COMPLIANCE.md`
- **Prototype branch: `test/bluetooth-wifi-connect`** (see §11)

## 11. Existing prototype to harvest (`test/bluetooth-wifi-connect`)

A 2-commit branch (not merged) ships a **debug harness**, not product UX - but
its transport + crypto layer is solid and battle-tested on real hardware.

### Files

| File | Verdict |
|---|---|
| `src/features/ble/bleWifi.ts` (316 l.) | **Keep** - transport + crypto, full of hard-won fixes |
| `src/ui/screens/BleWifiDebugScreen.tsx` (265 l.) | **Discard** - Fab + Dialog + button soup + log pane (the "hacky" UI) |
| `Cargo.toml`, `lib.rs`, `capabilities/default.json`, `package.json`, `main.tsx` | **Reuse** - native wiring already correct |

### What to take

- **`buildSealedConnect()`** - the full `x25519-hkdf-sha256-aesgcm` sealing,
  verified byte-for-byte against the daemon, on `@noble/{curves,hashes,ciphers}`.
  The hardest piece, already done. Reuse nearly as-is as `seal.ts`.
- **Native wiring** - `tauri-plugin-blec = "0.4"` + `@mnlphlp/plugin-blec@^0.4`,
  `.plugin(tauri_plugin_blec::init())` in `lib.rs`, `blec:default` +
  `blec:allow-check-permissions` in capabilities.
- **`sendCommand()`** - write → read sync reply → if `OK: working`, await the
  next notification. The daemon's async model, handled.

### Hard-won BLE gotchas baked into `bleWifi.ts` (KEEP these)

1. `startScan` **resolves immediately** (background scan); keep collecting for
   the window, don't stop right away (stopping early killed the scan).
2. blec **0.4.x drops devices whose `name` is null** (Kotlin early-return) - an
   OS-visible robot can be invisible to the scan on Android (worsens §4.1).
3. `blecConnect()` **swallows errors and resolves anyway** - drive the
   `connected` flag from `getConnectionUpdates()`, not from its promise.
4. `checkPermissions()` **also triggers** the Android runtime prompt (1st scan
   shows the dialog + returns false; scan again after granting).
5. **Notification backlog queue** so a notif landing before we await isn't lost.
6. **`withTimeout()` per step** so nothing hangs silently.
7. `subscribeString` may fail but sync-reply commands still work (non-fatal).
8. Device **normalization** across plugin versions (`address|id|uuid`,
   `name|localName`, `services|serviceUuids`).
9. `looksLikeReachy()` matches **name regex OR service UUID** (`cdef0`/`cdef3`).

### What to fix when productizing

- Replace module-level mutable singletons (`_notifResolve`, `_subscribed`,
  `_connWatchStarted`, `_notifBacklog`) with a class/closure owned by the FSM.
- Drop the hardcoded default PIN, the `BLE` Fab, and the `BleDevEntry` mount in
  `main.tsx`.
- Add real error mapping (§5.4), phases (§5.3), and the central handoff (§4.1).
