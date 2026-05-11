/**
 * Single log row inside the DaemonLogConsole.
 *
 * Layout (single line, badge-free):
 *
 *   ┌──────────────────────────────────────────┐
 *   │ Daemon started successfully.    13:30:24 │
 *   └──────────────────────────────────────────┘
 *
 * The leading category badge was dropped on the second iteration:
 * on a phone width it ate roughly 40 px on every row for very
 * little signal (the message text itself is usually self-evidently
 * a daemon line vs an app line). The level-driven message colour
 * still carries the severity hint (errors render red, warnings
 * orange, debug muted), which is the only category-vs-other piece
 * of information a user actually scans for.
 *
 * The timestamp is a bare `HH:MM:SS` (no milliseconds) on the
 * right edge. Milliseconds were noise at this granularity: log
 * lines are roughly 1 Hz on a quiet daemon, the second-precision
 * column is enough to correlate with what the user just did.
 *
 * Wrapped in `React.memo` because the parent re-renders on every
 * incoming line: every existing row receives identical props and
 * the memo lets React skip the entire reconcile for them. The
 * `entry` reference is stable (the hook only ever appends), so the
 * default shallow comparison does the right thing.
 */

import { Box, Typography } from "@mui/material";
import { memo } from "react";

import type { DaemonLogEntry } from "@/features/daemon-logs";
import { TYPO } from "@/ui/design/tokens";

import { levelColor } from "./categoryMeta";

interface LogLineRowProps {
  entry: DaemonLogEntry;
  isDark: boolean;
}

function LogLineRowImpl({ entry, isDark }: LogLineRowProps) {
  const messageColor = levelColor(entry.level, isDark);
  const timestampColor = isDark
    ? "rgba(255, 255, 255, 0.4)"
    : "rgba(0, 0, 0, 0.45)";

  // Trim the trailing `.mmm` off the cached clock-time so the
  // displayed value stays HH:MM:SS even though the underlying entry
  // was built with millisecond precision (we keep it on the entry
  // for "Copy all", which benefits from sub-second ordering).
  const shortTime = entry.clockTime.slice(0, 8);

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "flex-start",
        gap: 0.75,
        px: 1,
        py: 0.4,
      }}
    >
      <Typography
        component="div"
        sx={{
          flex: 1,
          minWidth: 0,
          fontSize: TYPO.tiny,
          fontFamily: "inherit",
          color: messageColor,
          lineHeight: 1.45,
          // Wrap long lines (the daemon emits 200+ char tracebacks)
          // instead of forcing a horizontal scrollbar that's awful
          // to use with a thumb.
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {entry.line}
      </Typography>

      <Box
        component="span"
        sx={{
          flexShrink: 0,
          fontSize: TYPO.micro,
          fontFamily: "inherit",
          color: timestampColor,
          // Match the message's first-line line-height so the
          // timestamp aligns with the start of the line, not its
          // mid-baseline (which `flex-start` + a smaller font
          // would otherwise cause to look slightly low).
          lineHeight: 1.7,
        }}
      >
        {shortTime}
      </Box>
    </Box>
  );
}

export const LogLineRow = memo(LogLineRowImpl);
LogLineRow.displayName = "LogLineRow";
