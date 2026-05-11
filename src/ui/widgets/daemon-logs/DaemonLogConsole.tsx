/**
 * Daemon log console — pure presentational, no chrome of its own.
 *
 *   ╭ Daemon started successfully.       13:30:24 ╮
 *   │ [Central Relay] State transition…  13:30:25 │
 *   │ [app] starting hand_tracker …      13:30:27 │
 *   │ ...                                         │
 *   ╰─────────────────────────────────────────────╯
 *
 * Lives inside a parent surface (today: a `<RobotPanel>` on the
 * Robot tab) which provides the title strip, the sub-text, and any
 * actions (copy button, etc.). This component renders the **scroll
 * area + entries + empty state** and nothing else - no header, no
 * card border. The terminal-ish bg is applied here because it's
 * the content that demands it (monospace, dim chrome, etc.); the
 * parent panel deliberately opts out of body chrome via
 * `noBodyChrome` so we can paint edge-to-edge.
 *
 * State is OWNED by the host
 * ──────────────────────────
 * Earlier iterations had this component call `useDaemonLogs`
 * directly. That made it a pain to add UI bits that depend on the
 * stream (e.g. a copy button up in the parent header) without
 * either re-running the hook in the parent (= duplicate
 * subscription) or threading callbacks through props. Now the
 * host calls the hook once and passes `entries` / `status` /
 * `errorMessage` down. The component is purely a view; the host
 * owns the data.
 *
 * Auto-scroll behavior
 * ────────────────────
 * The console pins to the bottom while the user hasn't manually
 * scrolled away from it. The "is the user near the bottom?"
 * threshold is intentionally generous (24 px) so a finger that
 * over-shoots by a few pixels doesn't break the live tail.
 *
 * As soon as the user scrolls up beyond the threshold the auto-pin
 * disengages and stays disengaged until they scroll back down to
 * the bottom (also within the threshold). This matches what every
 * terminal log viewer ever shipped does.
 *
 * `programmaticScrollRef` exists to filter out our own
 * `scrollTop = scrollHeight` writes from `handleScroll`: without
 * it, the imperative scroll-to-bottom would itself trip the "user
 * scrolled near bottom" check. The flag suppresses the synthetic
 * event so only true user gestures change the pin state.
 */

import { useTheme } from "@mui/material/styles";
import { Box, Typography } from "@mui/material";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type {
  DaemonLogEntry,
  DaemonLogStreamStatus,
} from "@/features/daemon-logs";
import { TYPO } from "@/ui/design/tokens";

import { LogLineRow } from "./LogLineRow";

interface DaemonLogConsoleProps {
  entries: DaemonLogEntry[];
  status: DaemonLogStreamStatus;
  errorMessage: string | null;
  /**
   * Drives the "re-pin to bottom" effect. When the host's session
   * just became live (or just went offline and is coming back),
   * we re-engage auto-scroll so the very first incoming line
   * lands in view even if the user had previously scrolled up.
   */
  enabled: boolean;
}

const SCROLL_PIN_THRESHOLD_PX = 24;

export default function DaemonLogConsole({
  entries,
  status,
  errorMessage,
  enabled,
}: DaemonLogConsoleProps) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";

  const scrollRef = useRef<HTMLDivElement | null>(null);

  // True while we want the viewport pinned to the latest entry. The
  // user breaks the pin by scrolling up; landing back at the bottom
  // re-engages it. We mirror onto a ref so the layout-effect always
  // reads the freshest value (state read inside an effect would
  // be stale to the previous render, producing single-line lag
  // visible to the eye on fast bursts).
  const [autoScroll, setAutoScroll] = useState(true);
  const autoScrollRef = useRef(autoScroll);
  autoScrollRef.current = autoScroll;

  // Programmatic scrolls fire `onScroll` and we must NOT mistake
  // them for user scrolls (otherwise auto-scroll would suspend
  // itself the second it kicked in). This flag is raised right
  // before the imperative `scrollTop = scrollHeight` and lowered on
  // the next event-loop tick.
  const programmaticScrollRef = useRef(false);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    programmaticScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    queueMicrotask(() => {
      programmaticScrollRef.current = false;
    });
  }, []);

  useLayoutEffect(() => {
    if (!autoScrollRef.current) return;
    scrollToBottom();
  }, [entries, scrollToBottom]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (programmaticScrollRef.current) return;
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceFromBottom <= SCROLL_PIN_THRESHOLD_PX;
    setAutoScroll((prev) => (prev === nearBottom ? prev : nearBottom));
  }, []);

  // Re-pin on every enable transition (typically: the engine just
  // reached `ready` again). Without this, a user who had scrolled
  // up while the console was disabled would land on a non-pinned
  // empty console after re-enable.
  useEffect(() => {
    if (!enabled) return;
    setAutoScroll(true);
  }, [enabled]);

  const consoleBg = isDark ? "#0f0f0f" : "#ffffff";

  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        bgcolor: consoleBg,
        // No border / radius here — the parent `<RobotPanel>` owns
        // the card chrome. We paint a flat bg + handle our own
        // scroll inside.
        // Single mono font across the whole console so the right-
        // edge timestamp column reads as a column.
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      }}
    >
      <Box
        ref={scrollRef}
        onScroll={handleScroll}
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          overflowX: "hidden",
          // Mobile-friendly scrollbar: invisible by default, faint
          // on hover (desktop preview only - phones use the OS
          // overlay scrollbar regardless).
          "&::-webkit-scrollbar": { width: 4 },
          "&::-webkit-scrollbar-thumb": {
            background: isDark
              ? "rgba(255,255,255,0.18)"
              : "rgba(0,0,0,0.18)",
            borderRadius: 2,
          },
        }}
      >
        {entries.length === 0 ? (
          <EmptyState status={status} errorMessage={errorMessage} />
        ) : (
          <Box sx={{ display: "flex", flexDirection: "column", py: 0.5 }}>
            {entries.map((entry) => (
              <LogLineRow key={entry.id} entry={entry} isDark={isDark} />
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}

function EmptyState({
  status,
  errorMessage,
}: {
  status: DaemonLogStreamStatus;
  errorMessage: string | null;
}) {
  let message: string;
  switch (status) {
    case "idle":
      message = "Connect to the robot to stream daemon logs.";
      break;
    case "subscribing":
      message = "Subscribing…";
      break;
    case "live":
      message = "Daemon is quiet. Waiting for the next line…";
      break;
    case "error":
      message = errorMessage ?? "Stream error. Try reconnecting the robot.";
      break;
  }

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        minHeight: 80,
        px: 2,
      }}
    >
      <Typography
        sx={{
          fontSize: TYPO.tiny,
          color: "text.secondary",
          fontFamily: "inherit",
          textAlign: "center",
          lineHeight: 1.5,
        }}
      >
        {message}
      </Typography>
    </Box>
  );
}
