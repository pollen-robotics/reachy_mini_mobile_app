/**
 * Color helpers for the DaemonLogConsole.
 *
 * Originally hosted both a `CATEGORY_META` table (for the per-row
 * category badge) and `levelColor` (for the per-row message tint);
 * the badge was dropped on the second iteration of the mobile log
 * row design (see `LogLineRow.tsx`), leaving only `levelColor`.
 *
 * Filename kept as-is to minimise import churn; the module's true
 * scope is "row-level color decisions" now.
 */

import type { DaemonLogLevel } from "@/features/daemon-logs";

/**
 * Foreground colour for the message text, picked from the inferred
 * level. Light/dark variants tuned to stay legible on both the
 * console's near-black (dark) and near-white (light) backgrounds.
 */
export function levelColor(level: DaemonLogLevel, isDark: boolean): string {
  switch (level) {
    case "error":
      return isDark ? "#ff6b6b" : "#cc0000";
    case "warning":
      return isDark ? "#fbbf24" : "#d97706";
    case "debug":
      return isDark ? "#94a3b8" : "#64748b"; // slate, dimmed
    case "info":
    default:
      return isDark ? "#e5e7eb" : "#1f2937";
  }
}
