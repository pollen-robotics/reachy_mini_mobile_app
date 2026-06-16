/**
 * Latest daemon release lookup.
 *
 * The mobile app surfaces a "this Reachy needs an update" prompt right
 * after connecting to a robot whose daemon is behind the latest public
 * release. There is no "latest version" signal on the WebRTC data
 * channel (the daemon only reports its OWN version), so we resolve the
 * reference from GitHub Releases:
 *
 *   GET https://api.github.com/repos/pollen-robotics/reachy_mini/releases/latest
 *     → { "tag_name": "v1.8.2", ... }
 *
 * Fail-open discipline
 * ────────────────────
 * Every failure path (offline, rate-limited, unexpected shape) resolves
 * to `null`. Callers MUST treat `null` as "unknown - do not block": the
 * update prompt only ever appears when we positively know the daemon is
 * behind a parseable latest version.
 *
 * Caching
 * ───────
 * The latest release changes rarely; we cache the resolved version in
 * module memory AND `localStorage` with a 6 h TTL so re-connecting to
 * robots during a session doesn't hammer the (unauthenticated, 60 req/h
 * per IP) GitHub API.
 */

import { useEffect, useState } from 'react';

const REPO = 'pollen-robotics/reachy_mini';
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const CACHE_KEY = 'reachy.daemonLatestRelease.v1';
const TTL_MS = 6 * 60 * 60 * 1000;

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse a `MAJOR.MINOR.PATCH` string into a `SemVer`. Tolerates a
 * leading `v` (GitHub tags) and trailing pre-release / build metadata
 * (`1.8.2-rc1` → `1.8.2`). Returns `null` when the first three numeric
 * components can't be read, so callers can fail-open.
 */
export function parseSemver(value: string | null | undefined): SemVer | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** Negative if `a < b`, positive if `a > b`, 0 if equal. */
export function compareSemver(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * True only when BOTH versions parse AND `current` is strictly behind
 * `latest`. Any unparseable input returns `false` (fail-open): we never
 * nag the user on a version string we can't reason about.
 */
export function isDaemonOutdated(
  current: string | null | undefined,
  latest: string | null | undefined,
): boolean {
  const c = parseSemver(current);
  const l = parseSemver(latest);
  if (!c || !l) return false;
  return compareSemver(c, l) < 0;
}

interface CacheEntry {
  value: string | null;
  at: number;
}

let memo: CacheEntry | null = null;

function readLocalStorage(): CacheEntry | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CacheEntry>;
    if (typeof parsed.at !== 'number') return null;
    return { value: typeof parsed.value === 'string' ? parsed.value : null, at: parsed.at };
  } catch {
    return null;
  }
}

function writeCache(entry: CacheEntry): void {
  memo = entry;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    /* storage full / unavailable - memory cache still applies */
  }
}

function isFresh(entry: CacheEntry | null): boolean {
  return entry !== null && Date.now() - entry.at < TTL_MS;
}

/**
 * Resolve the latest published daemon version (e.g. `"1.8.2"`), or
 * `null` when it can't be determined. Cached in memory + localStorage
 * for `TTL_MS`. Never throws.
 */
export async function fetchLatestDaemonVersion(): Promise<string | null> {
  if (memo && isFresh(memo)) return memo.value;

  const stored = readLocalStorage();
  if (stored && isFresh(stored)) {
    memo = stored;
    return stored.value;
  }

  try {
    const res = await fetch(LATEST_URL, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      // Keep serving a stale cached value if we have one rather than
      // flapping to null on a transient 403 (rate limit) / 5xx.
      return stored?.value ?? null;
    }
    const json = (await res.json()) as { tag_name?: unknown };
    const tag = typeof json.tag_name === 'string' ? json.tag_name : null;
    const value = tag ? tag.replace(/^v/i, '') : null;
    writeCache({ value, at: Date.now() });
    return value;
  } catch {
    return stored?.value ?? null;
  }
}

/**
 * React hook returning the latest daemon version, or `null` until it
 * resolves / when it can't be determined. Kicks off a single fetch on
 * mount and serves the cached value synchronously on subsequent mounts.
 */
export function useLatestDaemonVersion(): string | null {
  const [latest, setLatest] = useState<string | null>(() =>
    memo && isFresh(memo) ? memo.value : null,
  );

  useEffect(() => {
    let cancelled = false;
    void fetchLatestDaemonVersion().then((value) => {
      if (!cancelled) setLatest(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return latest;
}
