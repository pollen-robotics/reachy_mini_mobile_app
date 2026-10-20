import { describe, expect, it } from 'vitest';

import type { AppEntry } from '@/features/apps/types';

import {
  findInstalled,
  hasSpaceId,
  normalizePythonCatalog,
  orphanRunningApp,
  sheetInstalledApp,
} from './catalog';
import type { InstalledRobotApp } from './types';

function raw(id: string, extra: Record<string, unknown>, top: Record<string, unknown> = {}) {
  return { id, name: id.split('/')[1], extra: { id, author: id.split('/')[0], ...extra }, ...top };
}

describe('normalizePythonCatalog', () => {
  it('keeps Python apps only, without the conversation app or blocked ones', () => {
    const apps = normalizePythonCatalog({
      apps: [
        raw('a/py', { isPythonApp: true, likes: 3 }),
        raw('a/js', { isPythonApp: false }),
        raw('pollen-robotics/reachy_mini_conversation_app', { isPythonApp: true }),
        raw('a/blocked', { isPythonApp: true }, { isBlocked: true }),
      ],
    });
    expect(apps.map(a => a.id)).toEqual(['a/py']);
  });

  it('puts official apps first, then sorts by likes', () => {
    const apps = normalizePythonCatalog({
      apps: [
        raw('a/low', { isPythonApp: true, likes: 1 }),
        raw('a/high', { isPythonApp: true, likes: 50 }),
        raw('pollen-robotics/off', { isPythonApp: true, likes: 0 }),
      ],
    });
    expect(apps.map(a => a.id)).toEqual(['pollen-robotics/off', 'a/high', 'a/low']);
  });
});

describe('findInstalled', () => {
  const entry = { id: 'Pollen/Marionette' } as AppEntry;
  const installed = (over: Partial<InstalledRobotApp>): InstalledRobotApp => ({
    name: 'marionette',
    spaceId: null,
    title: null,
    description: '',
    emoji: null,
    private: false,
    customAppUrl: null,
    ...over,
  });

  it('matches on the Space id first', () => {
    expect(
      findInstalled(entry, [installed({ name: 'x', spaceId: 'pollen/marionette' })])?.name
    ).toBe('x');
  });

  it('falls back to the repo name for installs without a Space id', () => {
    expect(findInstalled(entry, [installed({})])?.name).toBe('marionette');
  });

  it('does not match a same-named app from another Space', () => {
    expect(findInstalled(entry, [installed({ spaceId: 'someone/marionette' })])).toBeNull();
  });
});

describe('orphans (running, but missing from the installed list)', () => {
  const running = { state: 'running' as const, name: 'clock', error: null };
  const idle = { state: 'idle' as const, name: null, error: null };
  const clockInstalled: InstalledRobotApp = {
    name: 'clock',
    spaceId: 'pollen/clock',
    title: 'Clock',
    description: '',
    emoji: null,
    private: false,
    customAppUrl: null,
  };

  it('reports the app holding the slot when the list lacks it', () => {
    expect(orphanRunningApp([], running)?.name).toBe('clock');
    expect(orphanRunningApp(null, running)?.name).toBe('clock');
    expect(orphanRunningApp([clockInstalled], running)).toBeNull();
    expect(orphanRunningApp([], idle)).toBeNull();
  });

  it('gives the sheet the orphan for its catalog entry or its bare name', () => {
    const fromCatalog = { id: 'pollen/clock' } as AppEntry;
    const bareName = { id: 'clock' } as AppEntry;
    expect(sheetInstalledApp(fromCatalog, [], running)?.name).toBe('clock');
    expect(sheetInstalledApp(bareName, [], running)?.name).toBe('clock');
    expect(sheetInstalledApp({ id: 'pollen/other' } as AppEntry, [], running)).toBeNull();
    // An installed copy wins over the orphan path.
    expect(sheetInstalledApp(fromCatalog, [clockInstalled], running)).toBe(clockInstalled);
  });

  it('tells a Hub Space id from a bare app name', () => {
    expect(hasSpaceId({ id: 'pollen/clock' } as AppEntry)).toBe(true);
    expect(hasSpaceId({ id: 'clock' } as AppEntry)).toBe(false);
  });
});
