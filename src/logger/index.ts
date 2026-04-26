/**
 * Structured, namespaced, redacted console logger for the Reachy Mini
 * mobile app.
 *
 * Why a custom layer instead of `console.*`?
 *
 * - Permanent observation points need a *level* so we can emit DEBUG
 *   noise without drowning out INFO/WARN/ERROR in the default view.
 * - Namespaces let DevTools filter to one subsystem at a time
 *   (`localStorage.setItem('log:filter', 'central.*,session.*')`).
 * - Token redaction must happen **at the source**, not as a post-hoc
 *   review step. `redactObject` walks every emitted kv payload.
 * - A trace-id makes a single user action ("tap connect") followable
 *   across discovery, BLE, daemon HTTP, and engine layers; it is
 *   propagated as `X-Trace-Id` to the daemon (PR-B picks it up there).
 *
 * Runtime knobs (no rebuild required):
 *
 *   localStorage.setItem('log:level', 'debug')    // default 'info'
 *   localStorage.setItem('log:filter', 'central.*,session.*')
 *   window.__setLogLevel('debug')                 // takes effect now
 *
 * Convention: `logger.info('phase.transition', { from, to })` rather
 * than free-form sentences. The first argument is a stable event id
 * (snake/dot case), the second is structured kv.
 */
import { redactObject } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

let activeLevel: LogLevel = 'info';
let activeFilter: RegExp | null = null;

function compileFilter(spec: string): RegExp | null {
  const parts = spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const re = parts
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*'))
    .join('|');
  return new RegExp(`^(?:${re})$`);
}

function loadFromStorage(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const lvl = localStorage.getItem('log:level');
    if (lvl && lvl in LEVEL_RANK) activeLevel = lvl as LogLevel;
    const filt = localStorage.getItem('log:filter');
    if (filt) activeFilter = compileFilter(filt);
  } catch {
    // localStorage unavailable; stick with defaults.
  }
}
loadFromStorage();

export function setLogLevel(level: LogLevel): void {
  activeLevel = level;
  try {
    localStorage.setItem('log:level', level);
  } catch {
    // best-effort
  }
}

export function setLogFilter(spec: string | null): void {
  if (!spec) {
    activeFilter = null;
    try {
      localStorage.removeItem('log:filter');
    } catch {
      /* ignore */
    }
    return;
  }
  activeFilter = compileFilter(spec);
  try {
    localStorage.setItem('log:filter', spec);
  } catch {
    /* ignore */
  }
}

/* --- Trace id ----------------------------------------------------- */

let activeTrace: string | null = null;

/**
 * Set the current trace-id. Subsequent log calls (until the next set
 * or `clearTraceId()`) tag their output with it. We deliberately use
 * a module-global variable rather than React Context so non-React code
 * paths (engine, BLE adapter) inherit the same id.
 */
export function setTraceId(trace: string | null): void {
  activeTrace = trace;
}

export function getTraceId(): string | null {
  return activeTrace;
}

/**
 * 4-character base36 id, short enough to scan in DevTools, long enough
 * to dedupe within a session (1.7M values, way more than the number
 * of concurrent flows we'll ever see in one app session).
 */
export function newTraceId(): string {
  return Math.random().toString(36).slice(2, 6).padStart(4, '0');
}

/**
 * Run `fn` with `trace` set as the active trace-id, restoring the
 * previous one when it returns or throws. Useful for wrapping a whole
 * connection attempt:
 *
 *   await withTrace(newTraceId(), async () => { ... });
 */
export async function withTrace<T>(trace: string, fn: () => Promise<T>): Promise<T> {
  const prev = activeTrace;
  activeTrace = trace;
  try {
    return await fn();
  } finally {
    activeTrace = prev;
  }
}

/* --- Logger ------------------------------------------------------- */

export interface Logger {
  debug(event: string, kv?: Record<string, unknown>): void;
  info(event: string, kv?: Record<string, unknown>): void;
  warn(event: string, kv?: Record<string, unknown>): void;
  error(event: string, kv?: Record<string, unknown>): void;
  child(subns: string): Logger;
}

type EmitLevel = 'debug' | 'info' | 'warn' | 'error';

function makeLogger(ns: string): Logger {
  const enabled = (level: LogLevel): boolean => {
    if (LEVEL_RANK[level] < LEVEL_RANK[activeLevel]) return false;
    if (activeFilter && !activeFilter.test(ns)) return false;
    return true;
  };

  const emit = (level: EmitLevel, event: string, kv?: Record<string, unknown>): void => {
    if (!enabled(level)) return;
    const tag =
      level === 'debug' ? 'DBG' : level === 'info' ? 'INF' : level === 'warn' ? 'WRN' : 'ERR';
    const traceTag = activeTrace ? `[${activeTrace}] ` : '';
    const head = `${tag} ${traceTag}${ns} ${event}`;
    const safeKv = kv ? (redactObject(kv) as Record<string, unknown>) : undefined;

    const method: 'log' | 'warn' | 'error' =
      level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';

    if (safeKv && Object.keys(safeKv).length > 0) {
      console[method](head, safeKv);
    } else {
      console[method](head);
    }
  };

  return {
    debug: (event, kv) => emit('debug', event, kv),
    info: (event, kv) => emit('info', event, kv),
    warn: (event, kv) => emit('warn', event, kv),
    error: (event, kv) => emit('error', event, kv),
    child: (subns: string) => makeLogger(`${ns}.${subns}`),
  };
}

export function createLogger(ns: string): Logger {
  return makeLogger(ns);
}

/* --- DevTools convenience ----------------------------------------- */

declare global {
  interface Window {
    __setLogLevel?: typeof setLogLevel;
    __setLogFilter?: typeof setLogFilter;
    __getTraceId?: typeof getTraceId;
  }
}

if (typeof window !== 'undefined') {
  window.__setLogLevel = setLogLevel;
  window.__setLogFilter = setLogFilter;
  window.__getTraceId = getTraceId;
}
