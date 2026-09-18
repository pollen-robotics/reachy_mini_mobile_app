/**
 * Live daemon log pane for the Bluetooth tools hub.
 *
 * Presentational only: `BleToolsScreen` owns the `JOURNAL_*` poll loop and
 * hands us the accumulated text; we own the scroll behaviour. Split out of
 * the screen purely for size - it mirrors the screen's `Headline` /
 * text-button look so it reads as one of its steps.
 */
import { useEffect, useRef } from 'react';
import { Box, Button, Stack, Typography } from '@mui/material';

import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';

/** Within this many px of the bottom counts as "following the tail". */
const PIN_THRESHOLD_PX = 40;

export default function LogsView({
  text,
  paused,
  error,
  onTogglePause,
  onClear,
}: {
  text: string;
  paused: boolean;
  /** Set when the stream couldn't start / stopped; replaces the caption. */
  error: string | null;
  onTogglePause: () => void;
  onClear: () => void;
}) {
  const paneRef = useRef<HTMLDivElement>(null);
  // Stay pinned to the bottom as lines arrive, unless the user scrolled up
  // to read something: pinned = was near the bottom before the append
  // (tracked on scroll, applied after each text change).
  const pinnedRef = useRef(true);
  useEffect(() => {
    const el = paneRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <Stack spacing={1.5} sx={{ width: '100%' }}>
      <Stack spacing={0.75} sx={{ alignItems: 'center', textAlign: 'center' }}>
        <Typography sx={{ fontSize: TYPO.xl, fontWeight: FONT_WEIGHT.semibold }}>
          Daemon logs
        </Typography>
        <Typography
          sx={{ fontSize: TYPO.sm, color: 'text.secondary', maxWidth: 300, lineHeight: 1.5 }}
        >
          {error ?? (paused ? 'Paused.' : 'Streaming from the robot…')}
        </Typography>
      </Stack>
      <Box
        ref={paneRef}
        onScroll={e => {
          const el = e.currentTarget;
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX;
        }}
        sx={{
          height: 'min(60vh, 520px)',
          overflowY: 'auto',
          p: 1.5,
          borderRadius: `${RADIUS.md}px`,
          // Deliberately theme-independent: a terminal is dark in both modes.
          bgcolor: '#141414',
          color: '#d4d4d4',
          fontFamily: 'monospace',
          fontSize: TYPO.tiny,
          lineHeight: 1.45,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {text || (error ? '' : 'Waiting for output…')}
      </Box>
      <Stack direction="row" spacing={1} sx={{ justifyContent: 'center' }}>
        <Button
          variant="text"
          onClick={onTogglePause}
          disabled={error !== null}
          sx={{ textTransform: 'none', fontWeight: FONT_WEIGHT.semibold }}
        >
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <Button
          variant="text"
          onClick={onClear}
          disabled={!text}
          sx={{ textTransform: 'none', fontWeight: FONT_WEIGHT.semibold }}
        >
          Clear
        </Button>
      </Stack>
    </Stack>
  );
}
