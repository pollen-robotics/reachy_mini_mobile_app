/**
 * Telepresence tab dev harness: `yarn dev`, then open
 * http://localhost:1422/telepresence-harness.html
 *
 * Renders the real `TelepresencePanel` against a fake robot whose data
 * channel answers the daemon's hoverboard commands with the same state
 * machine, replies and 300 ms deadman as `HoverboardManager`, so the base
 * UI can be iterated on without a robot, a base, a phone or sign-in.
 *
 * Query params:
 *   ?fw=silent     stock firmware (no acks, no telemetry)
 *   ?link=up       start with the base already connected
 *   ?hb=off        daemon without hoverboard support
 *
 * `window.__harness` exposes the fake daemon (frames, state) for scripts.
 */
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CssBaseline, ThemeProvider } from '@mui/material';

import { DaemonStateProvider } from '@/features/daemon-state';
import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';
import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';
import TelepresencePanel from '@/ui/panels/telepresence/TelepresencePanel';

import { darkTheme } from '../theme';

const params = new URLSearchParams(location.search);
const silentFw = params.get('fw') === 'silent';
const hoverboardEnabled = params.get('hb') !== 'off';

type FwState = 'Stopped' | 'Liftoff' | 'Balancing' | 'Stopping';

class FakeDaemon {
  connected = params.get('link') === 'up';
  connecting = false;
  state: FwState = 'Stopped';
  balancerRequested = false;
  throttle = 0;
  turn = 0;
  lastDriveAt = 0;
  zeroedByDeadman = false;
  tilt = 3.7;
  lastStop: { reason: string; at: number; detail: string | null } | null = null;
  /** Replies the fake daemon sent for hoverboard_drive (should stay 0 with ack: false). */
  driveAcks = 0;

  stopped(reason: string, detail: string | null = null) {
    if (this.state === 'Liftoff' || this.state === 'Balancing') this.lastStop = { reason, at: Date.now() / 1000, detail };
  }

  /** Simulate a tilt cutoff: `__harness.tip()` in the console. */
  tip() {
    this.stopped('board', 'board went Stopped on its own');
    this.state = 'Stopped';
    this.balancerRequested = false;
    this.note('board stopped on its own');
  }
  frames: { t: number; throttle: number; turn: number }[] = [];
  log: string[] = [];

  constructor() {
    setInterval(() => {
      if (this.lastDriveAt && Date.now() - this.lastDriveAt > 300 && !this.zeroedByDeadman) {
        if (this.throttle !== 0 || this.turn !== 0) this.note('DEADMAN zeroed the drive');
        this.throttle = 0;
        this.turn = 0;
        this.zeroedByDeadman = true;
      }
      this.tilt = this.state === 'Balancing' ? Math.sin(Date.now() / 700) * 1.5 + this.throttle / 20 : 3.7;
    }, 50);
  }

  note(line: string) {
    this.log = [`${new Date().toISOString().slice(17, 23)} ${line}`, ...this.log].slice(0, 12);
  }

  status() {
    return {
      enabled: true,
      link: {
        kind: this.connected ? 'bluetooth' : null,
        target: this.connected ? '4C:75:25:E4:B1:D6/1' : null,
        connected: this.connected,
        connecting: this.connecting,
        since: null,
        error: null,
      },
      firmware: { acks: !silentFw, telemetry: !silentFw, last_ack_age_s: 0.1 },
      drive: {
        throttle: this.throttle,
        turn: this.turn,
        balancer_requested: this.balancerRequested,
        zeroed_by_deadman: this.zeroedByDeadman,
        last_drive_age_s: this.lastDriveAt ? (Date.now() - this.lastDriveAt) / 1000 : null,
      },
      telemetry: silentFw ? null : { state: this.state, tilt_deg: this.tilt, wheel_velocity: [0, 0], battery_v: 36.4 },
      telemetry_age_s: silentFw ? null : 0.1,
      last_stop: this.lastStop,
      usb_ports: [],
      config: {},
    };
  }

  /** One data-channel command in, zero or one reply out (after `delayMs`). */
  handle(cmd: Record<string, unknown>): { reply: Record<string, unknown> | null; delayMs: number } {
    const type = String(cmd.type);
    if (!type.startsWith('hoverboard_')) return { reply: null, delayMs: 0 };
    if (!hoverboardEnabled) return { reply: { error: 'hoverboard support is disabled', command: type }, delayMs: 20 };
    const ok = { status: 'ok', command: type };
    const notConnected = { error: 'hoverboard not connected', command: type };
    switch (type) {
      case 'hoverboard_get_status':
        return { reply: { command: type, hoverboard: this.status() }, delayMs: 30 };
      case 'hoverboard_connect':
        this.note('connect');
        this.connecting = true;
        setTimeout(() => {
          this.connecting = false;
          this.connected = true;
        }, 1500);
        return { reply: { ...ok, link: this.status().link }, delayMs: 1600 };
      case 'hoverboard_enable':
        if (!this.connected) return { reply: notConnected, delayMs: 20 };
        this.note('enable (S0)');
        this.balancerRequested = true;
        this.state = 'Liftoff';
        setTimeout(() => this.state === 'Liftoff' && (this.state = 'Balancing'), 600);
        return { reply: ok, delayMs: 20 };
      case 'hoverboard_sit':
        if (!this.connected) return { reply: notConnected, delayMs: 20 };
        this.note('sit (S1)');
        this.stopped('sit_command');
        this.balancerRequested = false;
        this.state = 'Stopping';
        setTimeout(() => this.state === 'Stopping' && (this.state = 'Stopped'), 1200);
        return { reply: ok, delayMs: 20 };
      case 'hoverboard_stop':
        if (!this.connected) return { reply: notConnected, delayMs: 20 };
        this.note('STOP (E1)');
        this.stopped('stop_command');
        this.balancerRequested = false;
        this.state = 'Stopped';
        this.throttle = 0;
        this.turn = 0;
        return { reply: ok, delayMs: 20 };
      case 'hoverboard_drive': {
        if (!this.connected) return { reply: notConnected, delayMs: 20 };
        this.throttle = Number(cmd.throttle);
        this.turn = Number(cmd.turn);
        this.lastDriveAt = Date.now();
        this.zeroedByDeadman = false;
        this.frames = [...this.frames, { t: Date.now(), throttle: this.throttle, turn: this.turn }].slice(-200);
        if (cmd.ack === false) return { reply: null, delayMs: 0 };
        this.driveAcks += 1;
        return { reply: ok, delayMs: 20 };
      }
      default:
        return { reply: { error: `unknown ${type}`, command: type }, delayMs: 20 };
    }
  }
}

const daemon = new FakeDaemon();
(window as unknown as { __harness: FakeDaemon }).__harness = daemon;

function createFakeRobot(): ReachyMiniInstance {
  const target = new EventTarget();
  const waiters: { match: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }[] =
    [];
  const deliver = (msg: Record<string, unknown>) => {
    if (typeof msg.error === 'string') {
      target.dispatchEvent(new CustomEvent('error', { detail: { source: 'robot', error: msg.error } }));
    }
    const i = waiters.findIndex((w) => w.match(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
  };
  const send = (cmd: Record<string, unknown>) => {
    const { reply, delayMs } = daemon.handle(cmd);
    if (reply) setTimeout(() => deliver(reply), delayMs);
    return true;
  };
  const robot = Object.assign(target, {
    state: 'streaming',
    robots: [],
    username: 'harness',
    isAuthenticated: true,
    micSupported: false,
    micMuted: true,
    audioMuted: true,
    peerConnection: null,
    robotState: { motor_mode: 'enabled', head: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], body_yaw: 0 },
    isAwake: () => true,
    wakeUp: async () => {},
    subscribePose: () => {},
    unsubscribePose: () => {},
    sendRaw: (data: unknown) => send(data as Record<string, unknown>),
    request: (cmd: { type: string } & Record<string, unknown>, opts?: { timeoutMs?: number }) =>
      new Promise<Record<string, unknown> | null>((resolve) => {
        const waiter = { match: (m: Record<string, unknown>) => m.command === cmd.type, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) {
            waiters.splice(i, 1);
            resolve(null);
          }
        }, opts?.timeoutMs ?? 3000);
        send(cmd);
      }),
  });
  // Anything the panel touches that the harness doesn't model is a no-op.
  return new Proxy(robot, {
    get: (obj, key) => (key in obj ? Reflect.get(obj, key) : () => undefined),
  }) as unknown as ReachyMiniInstance;
}

const robot = createFakeRobot();

const session = {
  phase: 'live',
  hasReachedReady: true,
  getRobot: () => robot,
  attachVideo: () => () => {},
} as unknown as RobotSessionHandle;

const daemonSession = {} as React.ComponentProps<typeof DaemonStateProvider>['session'];

function Debug() {
  const [, force] = useState(0);
  useState(() => setInterval(() => force((n) => n + 1), 200));
  const recent = daemon.frames.filter((f) => Date.now() - f.t < 1000);
  return (
    <pre
      data-testid="harness-debug"
      style={{
        position: 'fixed',
        top: 70,
        left: 8,
        zIndex: 2000,
        margin: 0,
        font: '10px/1.3 monospace',
        color: '#0f0',
        background: 'rgba(0,0,0,0.6)',
        padding: 6,
        pointerEvents: 'none',
      }}
    >
      {`fake daemon  link=${daemon.connected ? 'up' : daemon.connecting ? 'connecting' : 'down'} fw=${daemon.state}
drive T${daemon.throttle} R${daemon.turn} · ${recent.length} frames/s${daemon.zeroedByDeadman ? ' · deadman' : ''}
${daemon.log.join('\n')}`}
    </pre>
  );
}

function Harness() {
  const [manual, setManual] = useState(false);
  return (
    <DaemonStateProvider session={daemonSession} enabled={false}>
      <TelepresencePanel
        session={session}
        manualMode={manual}
        onManualModeChange={setManual}
        onExit={() => {}}
        allowMotion
      />
      <Debug />
    </DaemonStateProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider theme={darkTheme}>
      <CssBaseline />
      <Harness />
    </ThemeProvider>
  </StrictMode>,
);
