/**
 * React glue for the overboard (wheeled base) joystick.
 *
 *   mode 'webrtc' → drive frames on the robot data channel (telepresence)
 *   mode 'ble'    → drive frames straight to the overboard over BLE
 *                   (manual mode, stubbed - see `ble-link.ts`)
 *
 * The drive loop only runs while `active`; switching mode or going
 * inactive flushes a STOP burst on the old link first.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';

import { createOverboardBleStub, type BleLinkSnapshot, type OverboardBleLink } from './ble-link';
import { OverboardDriver } from './driver';
import type { OverboardLink } from './link';
import type { OverboardLinkStats, OverboardMode } from './types';
import { createOverboardWebRtcLink } from './webrtc-link';

const STATS_POLL_MS = 500;

export interface UseOverboardOptions {
  mode: OverboardMode;
  active: boolean;
  getRobot: () => ReachyMiniInstance | null;
  getDeflection: () => { x: number; y: number } | null;
}

export interface OverboardHandle {
  stats: OverboardLinkStats;
  ble: BleLinkSnapshot;
  connectBle(): void;
}

export function useOverboard({
  mode,
  active,
  getRobot,
  getDeflection,
}: UseOverboardOptions): OverboardHandle {
  const getRobotRef = useRef(getRobot);
  getRobotRef.current = getRobot;
  const getDeflectionRef = useRef(getDeflection);
  getDeflectionRef.current = getDeflection;

  const [webrtcLink] = useState(() => createOverboardWebRtcLink(() => getRobotRef.current()));
  const [bleLink] = useState<OverboardBleLink>(() => createOverboardBleStub());
  const link: OverboardLink = mode === 'ble' ? bleLink : webrtcLink;

  useEffect(() => {
    if (!active) return;
    const driver = new OverboardDriver(
      () => getDeflectionRef.current(),
      () => link,
    );
    driver.start();
    return () => driver.stop();
  }, [active, link]);

  // Declared AFTER the driver effect on purpose: unmount cleanups run in
  // declaration order, so the driver's final STOP burst goes out before
  // the links are torn down.
  useEffect(
    () => () => {
      webrtcLink.dispose();
      bleLink.dispose();
    },
    [webrtcLink, bleLink],
  );

  // BLE radio follows manual mode: connect on entry, drop on exit.
  useEffect(() => {
    if (mode !== 'ble' || !active) return;
    void bleLink.connect();
    return () => bleLink.disconnect();
  }, [mode, active, bleLink]);

  const ble = useSyncExternalStore(bleLink.subscribe, bleLink.getSnapshot);

  const [stats, setStats] = useState<OverboardLinkStats>(() => link.getStats());
  useEffect(() => {
    setStats(link.getStats());
    if (!active) return;
    const poll = setInterval(() => setStats(link.getStats()), STATS_POLL_MS);
    return () => clearInterval(poll);
  }, [active, link]);

  return { stats, ble, connectBle: () => void bleLink.connect() };
}
