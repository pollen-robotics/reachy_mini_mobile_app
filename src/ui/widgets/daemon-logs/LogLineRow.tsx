/**
 * Single log row inside the DaemonLogConsole.
 *
 * Layout (single line, badge-free, no timestamp):
 *
 *   ┌──────────────────────────────────────────┐
 *   │ Daemon started successfully.             │
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
 * The right-edge `HH:MM:SS` clock used to live here too but was
 * dropped on user feedback: at this granularity (lines arrive
 * mostly second-by-second, the buffer caps at 100) the visible
 * column is a fully accurate timeline by itself, and the
 * timestamps added a chunk of monospace noise next to every
 * line. The wall-clock value is still kept on each
 * `DaemonLogEntry` (`clockTime`) so the "Copy all" affordance
 * exports something useful when the user is forensically
 * correlating against another tool.
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

  return (
    <Box
      sx={{
        // Single full-width column now that the timestamp is gone.
        // No flex needed - a plain block with horizontal padding
        // does the job and lets long lines wrap naturally.
        px: 1,
        py: 0.4,
      }}
    >
      <Typography
        component="div"
        sx={{
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
    </Box>
  );
}

export const LogLineRow = memo(LogLineRowImpl);
LogLineRow.displayName = "LogLineRow";
