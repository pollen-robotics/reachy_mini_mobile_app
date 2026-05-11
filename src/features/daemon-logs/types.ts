/**
 * Type definitions for the daemon log streaming module.
 *
 * The daemon's `subscribe_logs` DataChannel command emits raw lines
 * from `journalctl -u reachy-mini-daemon` (one wire message per line,
 * see `LogLineMsg` in `reachy_mini/io/protocol.py`). The lines are
 * pre-formatted by Python's standard logger:
 *
 *     2026-05-10T11:35:35.123Z - reachy_mini.daemon.daemon - INFO - Daemon started successfully.
 *
 * Levels and categories are NOT carried on the wire: they are
 * inferred client-side by `parseDaemonLogLevel` /
 * `categorizeDaemonLine` so the daemon stays a thin pipe and we
 * don't have to keep the wire schema in sync with the desktop's
 * already-evolved level taxonomy.
 *
 * Mirrors the desktop app's vocabulary (see
 * `reachy_mini_desktop_app/src/utils/logging`) so consumers that
 * already know one map straight to the other - the only difference
 * is that the mobile app does not have a `frontend` source: every
 * entry comes from the daemon stream.
 */

/**
 * Coarse category, inferred from the Python logger name embedded in
 * the line. Used to render a small badge on each row.
 *
 * - `api`    : `uvicorn.access` / `uvicorn.error` (request-level)
 * - `app`    : `reachy_mini.apps.*` or `[app]`-prefixed (third-party
 *              app stdout/stderr piped via the app manager)
 * - `daemon` : everything else (default for bare prints, gstreamer,
 *              `reachy_mini.media.*`, motor backend, etc.)
 */
export type DaemonLogCategory = "api" | "app" | "daemon";

/**
 * Severity bucket. Inferred from `levelname` tokens embedded in the
 * formatted line; defaults to `info` when no level marker is found.
 */
export type DaemonLogLevel = "debug" | "info" | "warning" | "error";

/**
 * Normalized in-memory log entry rendered by the LogConsole.
 *
 * `id` is a monotonically-increasing local counter (NOT derived from
 * the timestamp, which is not strictly monotonic across multiple
 * journald records sharing the same wall clock). Used as the React
 * `key` so re-orderings don't cause spurious row remounts.
 *
 * `clockTime` is a `HH:MM:SS.mmm` string formatted client-side from
 * the line's local arrival time, NOT from the daemon's `timestamp`
 * field: the latter is in UTC ISO-8601 and looks ugly stacked next
 * to a list of clock times the user can compare to their own.
 */
export interface DaemonLogEntry {
  id: number;
  /** UTC ISO timestamp from journalctl, kept verbatim (debug only). */
  rawTimestamp: string;
  /** `HH:MM:SS.mmm` local clock time used for the right-hand column. */
  clockTime: string;
  /** Raw formatted log line as produced by the Python logger. */
  line: string;
  level: DaemonLogLevel;
  category: DaemonLogCategory;
}

/**
 * Connection state of the underlying log subscription. Surfaces as a
 * status pill in the console header so the user can tell whether
 * silence means "nothing happening on the daemon" vs "we lost the
 * stream and the buffer is stale".
 *
 * - `idle`        : we have not subscribed yet (e.g. session not live)
 * - `subscribing` : `subscribe_logs` sent, waiting for the first line
 * - `live`        : at least one line has arrived
 * - `error`       : daemon emitted `log_stream_error` (typically when
 *                   `journalctl` is unavailable on macOS dev hosts)
 */
export type DaemonLogStreamStatus = "idle" | "subscribing" | "live" | "error";
