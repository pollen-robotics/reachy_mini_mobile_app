# Overboard (wheeled base) control

The telepresence tab has a **Wheels** joystick that drives the overboard
add-on. There are two command paths with the same command shape.

| Mode | Path | Status |
|---|---|---|
| Normal telepresence | Robot WebRTC data channel → daemon → overboard | App side done; daemon side not written yet |
| Manual (settings → "Manual mode") | Phone → overboard over Bluetooth LE | Stub (`src/features/overboard/ble-link.ts`) |

## WebRTC wire format

This is a legacy `{"type": …}` command on the same data channel as
`set_full_target`:

```json
{"type": "overboard_drive", "linear": 0.42, "angular": -0.1, "seq": 17}
```

- `linear` is in [-1, 1]. Positive means forward.
- `angular` is in [-1, 1]. Positive means turn left (counter-clockwise from
  above, ROS REP-103).
- Both values are normalised. A quadratic curve is already applied (fine
  control near centre) and they are rounded to 3 decimals. The add-on maps
  them to real speeds.
- `seq` is a monotonic counter per link, so drops and reordering are
  detectable.

Rate (`src/features/overboard/driver.ts`):

- A **changed** command goes out on the next 100 ms tick (≤ 10 Hz).
- A **held** command is repeated every 500 ms as a heartbeat. The add-on
  should run a watchdog (for example, stop if nothing arrives for about
  1 s).
- On release, the app sends **3 explicit STOPs** (`linear = angular = 0`),
  then nothing.

### Today (no add-on yet)

The daemon doesn't know the type, so `_handle_webrtc_message` logs this in
`journalctl -u reachy-mini-daemon`:

```
WebRTC invalid command: … Input tag 'overboard_drive' found using 'type' does not match any of the expected tags …
```

It replies `{"error": "Invalid command: …"}`. The app counts those replies
as "daemon replies" in the telepresence settings sheet (Overboard section,
`sent N · daemon replies M`). The count proves the phone → daemon half of
the pipe works end-to-end. The engine only logs the reply, so it is
harmless.

To wire the add-on: add an `OverboardDriveCmd` to the command union in
`reachy_mini/io/protocol.py` (discriminator `type`) and handle it in
`process_command`.

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
