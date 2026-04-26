# PR-E — Session manager + multi-transport

## Goal

Encapsulate the session lifecycle (handshake → engine → live → leaving)
in a single hook `useRobotSession(presence)`. `RobotSessionScreen`
becomes a pure view rendering hook state. Add transport selection and
ICE failure observability.

## Why

`RobotSessionScreen` today owns too much: phase state machine, BLE
session, daemon probe, engine mounting, motor lifecycle, teardown,
menu state. It's hard to test, hard to extend, and the multi-transport
fallback story has nowhere to live.

## Scope

### `useRobotSession(presence: RobotPresence)`

Returns:

```ts
{
  phase: 'handshake' | 'live' | 'degraded' | 'leaving';
  step: number; // for the stepper UI
  client: RobotClient | null;
  engineState: AppState;
  errors: SessionDiagnostic[];
  leave: () => Promise<void>;
}
```

Internally orchestrates:

- Transport selection from `presence.preferredTransport`
- BLE session lifecycle (when transport === 'ble')
- WebRTC negotiation (when transport === 'central-webrtc')
- Daemon probe + version check (PR-D)
- Engine mount via `ConversePanel`
- Motor lifecycle via `setDesiredState(client, ...)`
- Graceful teardown: flush engine + motion, disconnect BLE/WebRTC

### Transport failover

- Monitor RTCPeerConnection ICE state (`webrtc.ice.state` log)
- Monitor LAN HTTP probe failures (`daemon.probe.unhealthy`)
- On hard failure of preferred transport, attempt the next ranked
  transport without dropping the user back to `Discovery`

### `RobotSessionScreen` simplification

- Becomes a presentational component
- All state lives in `useRobotSession`
- Stepper, top bar, conversation area all read from hook

## Out of scope

- AppsPanel/Forget Wi-Fi unification (= PR-F)
- New transports beyond the existing two

## Test plan

- Local LAN happy path: BLE → LAN HTTP, full session
- Remote happy path: central → WebRTC, full session
- Drop wifi mid-session in LAN mode → observe failover (or clean
  degraded → leaving)
- Kill daemon mid-session → observe ICE failure → leaving
- Verify leaving phase always completes (motor sleep, disconnect)
  within `TEARDOWN_TIMEOUT_MS`
