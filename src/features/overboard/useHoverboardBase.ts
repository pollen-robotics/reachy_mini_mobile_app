/**
 * Base lifecycle for the telepresence tab: polls the daemon's hoverboard
 * status while `active` and exposes connect / stand up / sit / stop.
 *
 * Commands are optimistic about nothing: after each one the poll is
 * kicked so the UI follows what the daemon (and the firmware telemetry)
 * actually report.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';

import { basePhase, parseStatus, type BasePhase, type HoverboardStatus } from './hoverboard';

const POLL_MS = 500;
const STATUS_TIMEOUT_MS = 1500;
/** Poll slower against a daemon without the hoverboard commands (each poll is logged as invalid there). */
const UNSUPPORTED_POLL_MS = 5000;
/** Bluetooth connect can take several seconds (rfcomm bind + first ack). */
const CONNECT_TIMEOUT_MS = 20_000;
const COMMAND_TIMEOUT_MS = 3000;

export type BaseCommand = 'connect' | 'enable' | 'sit' | 'stop';

export interface HoverboardBaseHandle {
  status: HoverboardStatus | null;
  phase: BasePhase;
  /** Command in flight, if any. */
  pending: BaseCommand | null;
  /** Last command or link error, cleared by the next success. */
  error: string | null;
  run(command: BaseCommand): void;
}

const COMMAND_TYPE: Record<BaseCommand, string> = {
  connect: 'hoverboard_connect',
  enable: 'hoverboard_enable',
  sit: 'hoverboard_sit',
  stop: 'hoverboard_stop',
};

export function useHoverboardBase({
  active,
  getRobot,
}: {
  active: boolean;
  getRobot: () => ReachyMiniInstance | null;
}): HoverboardBaseHandle {
  const getRobotRef = useRef(getRobot);
  getRobotRef.current = getRobot;
  const [status, setStatus] = useState<HoverboardStatus | null>(null);
  const [pending, setPending] = useState<BaseCommand | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollNow = useRef<() => void>(() => {});

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let inFlight = false;
    let skipUntil = 0;
    const poll = async (force = false) => {
      const robot = getRobotRef.current();
      if (!robot || inFlight || (!force && Date.now() < skipUntil)) return;
      inFlight = true;
      try {
        const reply = await robot.request({ type: 'hoverboard_get_status' }, { timeoutMs: STATUS_TIMEOUT_MS });
        if (cancelled) return;
        // null = timeout (daemon without the command); an `error` reply =
        // hoverboard support disabled. Both read as "unavailable".
        const parsed = reply ? parseStatus(reply.hoverboard) : null;
        skipUntil = parsed ? 0 : Date.now() + UNSUPPORTED_POLL_MS;
        setStatus(parsed);
      } catch {
        // Channel closed mid-flight: keep the last status, the session
        // layer handles the reconnect.
      } finally {
        inFlight = false;
      }
    };
    pollNow.current = () => void poll(true);
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      pollNow.current = () => {};
    };
  }, [active]);

  const run = useCallback((command: BaseCommand) => {
    const robot = getRobotRef.current();
    if (!robot) return;
    // STOP never waits behind another command.
    if (command !== 'stop') setPending(command);
    const timeoutMs = command === 'connect' ? CONNECT_TIMEOUT_MS : COMMAND_TIMEOUT_MS;
    robot
      .request({ type: COMMAND_TYPE[command] }, { timeoutMs })
      .then((reply) => {
        if (reply === null) setError(`${command}: no reply from the robot`);
        else if (typeof reply.error === 'string') setError(reply.error);
        else setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setPending((p) => (p === command ? null : p));
        pollNow.current();
      });
  }, []);

  return { status, phase: basePhase(status), pending, error: error ?? status?.link.error ?? null, run };
}
