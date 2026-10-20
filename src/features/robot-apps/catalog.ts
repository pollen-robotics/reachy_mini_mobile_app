/**
 * Catalog of Python apps the robot can install.
 *
 * Same public API Space as the JS catalog (`useApps`), but its unfiltered
 * `/api/apps` route, keeping only the entries flagged `isPythonApp`. The
 * conversation app is left out: the Talk tab installs and drives it.
 */
import { useQuery } from '@tanstack/react-query';

import type { AppEntry } from '@/features/apps/types';
import { normalizeApp } from '@/features/apps/useApps';
import { CONV_APP_NAME } from '@/features/conv-app/client';
import { WEBSITE_API_URL } from '@/shared/env';

import type { InstalledRobotApp, RobotAppRunStatus } from './types';

const CATALOG_ENDPOINT = `${WEBSITE_API_URL}/api/apps`;
export const PYTHON_APPS_QUERY_KEY = ['python-apps-catalog'] as const;
/** Mirrors the JS catalog's freshness window (server cache TTL). */
const STALE_TIME_MS = 5 * 60 * 1000;

interface RawEntry {
  isBlocked?: boolean;
  extra?: { isPythonApp?: boolean };
}

/** Python apps only, official first, then by likes. Exported for tests. */
export function normalizePythonCatalog(payload: unknown): AppEntry[] {
  const raw = Array.isArray(payload)
    ? payload
    : ((payload as { apps?: unknown[] } | null)?.apps ?? []);
  const apps: AppEntry[] = [];
  for (const entry of raw) {
    const meta = entry as RawEntry;
    if (meta?.extra?.isPythonApp !== true || meta.isBlocked === true) continue;
    const app = normalizeApp(entry as Parameters<typeof normalizeApp>[0]);
    if (!app || app.id.split('/').pop() === CONV_APP_NAME) continue;
    apps.push(app);
  }
  return apps.sort((a, b) => Number(b.isOfficial) - Number(a.isOfficial) || b.likes - a.likes);
}

async function fetchPythonCatalog(): Promise<AppEntry[]> {
  const res = await fetch(CATALOG_ENDPOINT, { credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return normalizePythonCatalog(await res.json());
}

export function usePythonAppsCatalog(enabled: boolean) {
  return useQuery({
    queryKey: PYTHON_APPS_QUERY_KEY,
    queryFn: fetchPythonCatalog,
    staleTime: STALE_TIME_MS,
    enabled,
  });
}

/**
 * The installed copy of a catalog app. The daemon keeps the Space id for apps
 * it installed from the Hub; older installs only match by name (the Space's
 * repo name, which is what the daemon names them).
 */
export function findInstalled(
  app: AppEntry,
  installed: readonly InstalledRobotApp[] | null
): InstalledRobotApp | null {
  if (!installed) return null;
  const id = app.id.toLowerCase();
  const repo = id.split('/').pop();
  return (
    installed.find(i => i.spaceId?.toLowerCase() === id) ??
    installed.find(i => !i.spaceId && i.name.toLowerCase() === repo) ??
    null
  );
}

/** The catalog entry for an installed app, if the catalog lists it. */
export function findCatalogEntry(
  installedApp: InstalledRobotApp,
  catalog: readonly AppEntry[] | undefined
): AppEntry | null {
  if (!catalog) return null;
  return catalog.find(app => findInstalled(app, [installedApp]) !== null) ?? null;
}

/**
 * A catalog-shaped entry for an installed app the catalog does not list
 * (private Space, delisted app), so the same tiles and sheet render it.
 */
export function installedAsEntry(installedApp: InstalledRobotApp): AppEntry {
  const id = installedApp.spaceId ?? installedApp.name;
  return {
    id,
    name: installedApp.title ?? installedApp.name,
    description: installedApp.description,
    spaceUrl: `https://huggingface.co/spaces/${id}`,
    author: installedApp.spaceId?.split('/')[0] ?? null,
    isOfficial: false,
    sdk: 'other',
    emoji: installedApp.emoji,
    iconUrl: null,
    tags: [],
    likes: 0,
    categories: null,
    categoriesSource: null,
    categorizedAt: null,
    extra: { isPythonApp: true },
  };
}

/** What to call an installed app (by entry name) in sentences shown to users. */
export function displayNameFor(
  name: string,
  installed: readonly InstalledRobotApp[] | null,
  catalog: readonly AppEntry[] | undefined
): string {
  const app = installed?.find(i => i.name === name);
  if (!app) return name;
  return findCatalogEntry(app, catalog)?.name ?? app.title ?? name;
}

/**
 * The app holding the slot when the installed list does not list it: its
 * package was removed while it ran, or the list has not loaded (old daemon).
 * It is still shown, so it can be stopped.
 */
export function orphanRunningApp(
  installed: readonly InstalledRobotApp[] | null,
  running: RobotAppRunStatus
): InstalledRobotApp | null {
  if (!running.name || running.state === 'idle') return null;
  if (installed?.some(app => app.name === running.name)) return null;
  return {
    name: running.name,
    spaceId: null,
    title: null,
    description: '',
    emoji: null,
    private: false,
    customAppUrl: null,
  };
}

/**
 * The installed app a sheet is about: its installed copy, else the orphan
 * holding the slot (matched by name, the only thing an orphan has), so the
 * sheet offers Stop instead of Install for an app that is running.
 */
export function sheetInstalledApp(
  app: AppEntry,
  installed: readonly InstalledRobotApp[] | null,
  running: RobotAppRunStatus
): InstalledRobotApp | null {
  const found = findInstalled(app, installed);
  if (found) return found;
  const orphan = orphanRunningApp(installed, running);
  const repo = app.id.toLowerCase().split('/').pop();
  return orphan && orphan.name.toLowerCase() === repo ? orphan : null;
}

/** Whether an entry names a real Hub Space (`owner/repo`), not a bare app name. */
export function hasSpaceId(app: AppEntry): boolean {
  return app.id.includes('/');
}
