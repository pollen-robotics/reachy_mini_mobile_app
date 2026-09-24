# Overboard (wheeled base) control

The telepresence tab has a **Wheels** joystick that drives the overboard
add-on. There are two command paths with the same command shape.

| Mode | Path | Status |
|---|---|---|
| Normal telepresence | Robot WebRTC data channel → daemon `HoverboardManager` → base (USB, else Bluetooth SPP) | Wired to the daemon's `hoverboard_*` commands |
| Manual (settings → "Manual mode") | Phone → overboard over Bluetooth LE | Stub (`src/features/overboard/ble-link.ts`) |

The daemon side lives on the private branch `feat/hoverboard` of
`RemiFabre/reachy_mini-hoverboard` (not released, keep it out of public
repos). Its spec is `docs/superpowers/specs/2026-09-24-hoverboard-daemon-design.md`.

## WebRTC commands

Legacy `{"type": …}` commands on the same data channel as
`set_full_target`. Each one replies `{"status": "ok", "command": <type>}`
or `{"error": "...", "command": <type>}` ("hoverboard not connected"
without a link, "hoverboard support is disabled" with `--no-hoverboard`).

| Command | Effect |
|---|---|
| `hoverboard_connect` `{link?: "auto"\|"usb"\|"bluetooth"}` | Bring the link up (USB first, else the remembered MAC). Takes seconds. |
| `hoverboard_enable` | Lift off and balance (firmware `S0`). In the air the wheels spin up to saturation. |
| `hoverboard_sit` | Controlled sit-down (`S1`). Needs the wheels on the ground. |
| `hoverboard_stop` | Motors off at once (`E1`). The STOP button. |
| `hoverboard_drive` `{throttle, turn}` | -100..100, forward and left positive. |
| `hoverboard_get_status` | `{"command": ..., "hoverboard": {enabled, link, firmware, drive, telemetry, ...}}` |

```json
{"type": "hoverboard_drive", "throttle": 42, "turn": -10}
```

- The joystick output is normalised to [-1, 1] with a quadratic curve
  (fine control near centre), then scaled to -100..100 with one decimal
  (`webrtc-link.ts`). The daemon applies the base's sign conventions and
  caps (`invert_throttle`, `max_throttle`, `max_turn`).
- **Deadman:** the daemon zeroes the drive 300 ms after the last
  `hoverboard_drive`, and when the WebRTC peer drops.

Rate (`src/features/overboard/driver.ts`):

- A changed command goes out on the next 100 ms tick (≤ 10 Hz).
- A held command is repeated every tick (100 ms heartbeat) so the deadman
  never fires while the stick is held.
- On release, the app sends **3 explicit STOPs**, then nothing.

## Base controls in the tab

`useHoverboardBase` polls `hoverboard_get_status` at 2 Hz while the tab
is live (the pose stream's `hoverboard` summary is dropped by the SDK),
backing off to 5 s when the daemon doesn't answer. `BaseControls` shows
the link and firmware state and the matching action:

| Phase | Shown when | Action |
|---|---|---|
| offline | no link | Connect |
| connecting | link coming up | none |
| sitting | connected, firmware `Stopped` | Stand up |
| lifting / balancing | `Liftoff` / `Balancing` | Sit |
| stopping | `Stopping` | none |

STOP is shown whenever the base is connected. The wheels joystick is
only live while the base balances. On the stock (silent) firmware there
is no telemetry, so the phase follows what was last requested.

## Dev harness

`yarn dev`, then open `http://localhost:1422/telepresence-harness.html`
(`?fw=silent`, `?link=up`, `?hb=off`). It renders the real panel against
a fake daemon with the same state machine, replies and deadman, plus a
debug overlay (drive frames per second, deadman events).

## Manual mode (BLE)

Turning manual mode on does three things:

1. Parks the head, base and antennas at neutral.
2. **Releases the robot WebRTC session**, the same handoff used by iframe
   apps.
3. Shows a black screen with the BLE link status, signal strength (RSSI)
   and the wheels joystick.

Turning it off (or leaving the tab) reacquires the session.

The BLE link implements `OverboardBleLink` (`connect`, `disconnect`,
`send`, `getSnapshot` → `{state, rssi, simulated, deviceName}`). The
current stub walks through the scan and connect states, reports a
**simulated** RSSI (the UI shows a `STUB` tag), and logs the frames it
would write. The real implementation should use `@mnlphlp/plugin-blec`
(already used by `features/ble/`) and follow the `reachy_mini_wheels_app`
Space protocol: service and characteristic UUIDs, frame encoding.
