/**
 * The conversation app's version and update state, as the About panel shows it.
 *
 * The daemon checks the installed app against its Hugging Face Space
 * (`apps.check_update`) and runs updates in the background (`apps.update`),
 * so the phone only polls. Daemons without these verbs read as `unknown`.
 */
import { useCallback, useEffect, useState } from 'react';

import type { ReachyMiniInstance } from '@/features/robot-session/sdk-types';

import { createConvAppClient, type ConvAppClient } from './client';

export type ConvAppUpdateState =
  | 'unknown'
  | 'not-installed'
  | 'up-to-date'
  | 'available'
  | 'updating'
  | 'failed';

export interface ConvAppUpdateView {
  state: ConvAppUpdateState;
  version: string | null;
}

const POLL_MS = 3000;
const UNKNOWN: ConvAppUpdateView = { state: 'unknown', version: null };

/** Read the daemon's view once. Any error (old daemon, offline) is `unknown`. */
export async function readUpdateState(client: ConvAppClient): Promise<ConvAppUpdateView> {
  try {
    const s = await client.checkConvAppUpdate();
    const version = s.version ?? null;
    if (s.updating) return { state: 'updating', version };
    if (s.error) return { state: 'failed', version };
    if (!s.installed) return { state: 'not-installed', version };
    return { state: s.update_available ? 'available' : 'up-to-date', version };
  } catch {
    return UNKNOWN;
  }
}

/** Start an update, then poll until the daemon reports it finished. */
export async function runUpdate(
  client: ConvAppClient,
  current: ConvAppUpdateView,
  onView: (view: ConvAppUpdateView) => void,
  sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))
): Promise<ConvAppUpdateView> {
  onView({ ...current, state: 'updating' });
  try {
    await client.updateConvApp();
  } catch {
    const failed = { ...current, state: 'failed' as const };
    onView(failed);
    return failed;
  }
  let view: ConvAppUpdateView = { ...current, state: 'updating' };
  while (view.state === 'updating') {
    await sleep(POLL_MS);
    const next = await readUpdateState(client);
    // The daemon leaves the version out mid-update; keep showing the old one.
    view = { ...next, version: next.version ?? current.version };
  }
  onView(view);
  return view;
}

export function useConvAppUpdate(getRobot: () => ReachyMiniInstance | null, enabled: boolean) {
  const [view, setView] = useState<ConvAppUpdateView>(UNKNOWN);

  useEffect(() => {
    const robot = getRobot();
    if (!enabled || !robot) return;
    let cancelled = false;
    void readUpdateState(createConvAppClient(robot)).then(v => {
      if (!cancelled) setView(v);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, getRobot]);

  const update = useCallback(() => {
    const robot = getRobot();
    if (robot) void runUpdate(createConvAppClient(robot), view, setView);
  }, [getRobot, view]);

  return { ...view, update };
}
