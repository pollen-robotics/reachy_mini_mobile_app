/**
 * Parsing helpers for raw daemon log lines.
 *
 * Ported from `reachy_mini_desktop_app/src/utils/logging/daemonLineParser.ts`
 * with two intentional deviations:
 *
 *   1. We drop the desktop's `success` level (it is exclusively
 *      emitted by frontend store events on desktop; the mobile
 *      app has no such source).
 *   2. We add `formatClockTime` here instead of importing it from
 *      a separate file: the mobile bundle has only one consumer of
 *      this helper, so co-location is simpler than a sibling util.
 *
 * Keep the categorisation rules in lockstep with the desktop's so
 * the two surfaces classify identical lines identically (a future
 * shared-skill / shared-test would catch drift, but for now mirror
 * the same regexes).
 */

import type {
  DaemonLogCategory,
  DaemonLogEntry,
  DaemonLogLevel,
} from "./types";

/**
 * Classify a raw log line emitted by the daemon process.
 *
 * Matches the Python logger names:
 *   - `uvicorn.access` / `uvicorn.error` -> `api`
 *   - `reachy_mini.apps.*` or any `[app]` / `_app.` prefix -> `app`
 *   - everything else -> `daemon` (bare prints, `reachy_mini.*`,
 *     `gst_plugin_webrtc_signalling`, `aiortc`, ...)
 */
export function categorizeDaemonLine(line: string): DaemonLogCategory {
  const lower = line.toLowerCase();
  if (lower.includes("uvicorn.access") || lower.includes("uvicorn.error")) {
    return "api";
  }
  if (
    lower.includes("reachy_mini.apps") ||
    lower.includes("_app.") ||
    lower.includes("[app]")
  ) {
    return "app";
  }
  return "daemon";
}

/**
 * Infer the level of a daemon line from its formatted text.
 *
 * The daemon uses Python's standard `%(asctime)s - %(name)s -
 * %(levelname)s - %(message)s` formatter, so we can detect
 * `ERROR` / `WARNING` / `DEBUG` tokens directly.
 */
export function parseDaemonLogLevel(line: string): DaemonLogLevel {
  if (line.includes(" - ERROR - ") || line.includes(" ERROR ")) return "error";
  if (line.includes(" - WARNING - ") || line.includes(" WARNING ")) {
    return "warning";
  }
  if (line.includes(" - DEBUG - ")) return "debug";
  return "info";
}

/**
 * Format a `Date.now()` timestamp as `HH:MM:SS.mmm` for the right-
 * hand column of each row. We intentionally drop the date: the
 * console only ever shows entries from the current session, the
 * date column would be visual noise.
 */
export function formatClockTime(epochMs: number): string {
  const d = new Date(epochMs);
  const pad2 = (n: number): string => n.toString().padStart(2, "0");
  const pad3 = (n: number): string => n.toString().padStart(3, "0");
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(
    d.getSeconds(),
  )}.${pad3(d.getMilliseconds())}`;
}

/**
 * Render the in-memory entry buffer as a plain-text dump suitable
 * for `clipboard.writeText`. Format: one line per entry, with the
 * full clock time (incl. milliseconds for sub-second ordering) and
 * the inferred category in square brackets, then the verbatim line.
 *
 *     14:50:17.123  [daemon]  Daemon started successfully
 *     14:50:17.480  [api]     uvicorn.access GET /healthz 200
 *
 * Used by the Robot tab's "copy" button. Kept here next to the
 * entry shape so a future change to `DaemonLogEntry` is one
 * file's worth of update instead of a hunt-the-formatter exercise.
 */
export function formatEntriesForCopy(entries: DaemonLogEntry[]): string {
  return entries
    .map((e) => `${e.clockTime}  [${e.category}]  ${e.line}`)
    .join("\n");
}
