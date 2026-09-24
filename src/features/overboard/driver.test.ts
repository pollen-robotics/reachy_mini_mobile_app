import { describe, expect, it } from 'vitest';

import { OverboardDriver } from './driver';
import { emptyStats, type OverboardLink } from './link';
import type { OverboardDrive } from './types';

function rig() {
  const sent: OverboardDrive[] = [];
  const link: OverboardLink = {
    mode: 'webrtc',
    send: (d) => sent.push(d),
    getStats: emptyStats,
    dispose: () => {},
  };
  const def = { x: 0, y: 0 };
  const driver = new OverboardDriver(() => def, () => link);
  return { sent, def, driver };
}

describe('OverboardDriver', () => {
  it('is silent while idle', () => {
    const { sent, driver } = rig();
    for (let i = 0; i < 20; i++) driver.tick();
    expect(sent).toHaveLength(0);
  });

  it('sends changes at once, repeats a held command at the heartbeat rate', () => {
    const { sent, def, driver } = rig();
    def.y = -1;
    for (let t = 0; t < 1000; t += 100) driver.tick(t);
    // t=0, then a heartbeat every 100 ms (under the daemon's 300 ms deadman)
    expect(sent).toHaveLength(10);
    def.y = -0.5;
    driver.tick(1000);
    expect(sent).toHaveLength(11);
    expect(sent[10]).toEqual({ linear: 0.25, angular: 0 });
  });

  it('keeps the heartbeat on a jittery 99 ms tick', () => {
    const { sent, def, driver } = rig();
    def.y = -1;
    for (let t = 0; t < 990; t += 99) driver.tick(t);
    expect(sent).toHaveLength(10);
  });

  it('sends a STOP burst on release', () => {
    const { sent, def, driver } = rig();
    def.y = -1;
    driver.tick(0);
    expect(sent[0]).toEqual({ linear: 1, angular: 0 });
    def.y = 0;
    for (let t = 100; t < 1100; t += 100) driver.tick(t);
    expect(sent).toHaveLength(4);
    expect(sent.slice(1)).toEqual([
      { linear: 0, angular: 0 },
      { linear: 0, angular: 0 },
      { linear: 0, angular: 0 },
    ]);
  });

  it('stop() while moving flushes STOPs', () => {
    const { sent, def, driver } = rig();
    driver.start();
    def.x = 1;
    driver.tick();
    driver.stop();
    expect(sent.at(-1)).toEqual({ linear: 0, angular: 0 });
  });
});
