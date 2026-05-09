/**
 * Terminal failure view, with an embedded auto-running diagnostic
 * (``WIFI_PROBE``) so the user reads a precise per-layer report
 * ("DNS broken", "Internet unreachable", "Daemon down") at the same
 * time as the failure headline - not after a manual "Diagnose" tap.
 *
 * The headline is picked in priority order:
 *   1. probe summary (most actionable),
 *   2. humanised raw error mapped from the daemon's `WIFI_STATUS.error`,
 *   3. generic fallback (last resort).
 */
import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  Collapse,
  Stack,
  Typography,
} from '@mui/material';
import CancelIcon from '@mui/icons-material/Cancel';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';

import {
  humanizeWifiError,
  summarizeProbeResult,
} from '@/features/wifi/humanizeWifiError';
import type { WifiProbeResult } from '@/types/robot';
import { FONT_WEIGHT, TYPO } from '@/ui/design/tokens';

type ProbeState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; result: WifiProbeResult }
  | { kind: 'error'; message: string };

export function FailedView({
  rawError,
  onRetry,
  onBack,
  onProbe,
  bleConnected,
}: {
  /** Raw error text from the daemon (typically `WIFI_STATUS.error`),
   * or `null` when the failure happened entirely client-side. */
  rawError: string | null;
  onRetry: () => void;
  onBack: () => void;
  /** Wired to `useWifiSetup.probe()`. Returns the parsed
   * `WifiProbeResult` or `null` if the daemon's payload was
   * unparseable. Throws on BLE errors. */
  onProbe: () => Promise<WifiProbeResult | null>;
  /** True iff the BLE link is still alive. WIFI_PROBE needs the BLE
   * channel; we hide the auto-probe path when it's gone (e.g. the
   * daemon dropped after a failed connect) since the call would
   * just throw. */
  bleConnected: boolean;
}) {
  const [probe, setProbe] = useState<ProbeState>({ kind: 'idle' });
  const [detailsOpen, setDetailsOpen] = useState(false);

  // Auto-run the probe on mount when the BLE link is still up.
  // WIFI_PROBE is public, no-auth, parallel, sub-2.5 s on the daemon -
  // so the round-trip is gratis. Doing it eagerly means the user
  // reads a precise message at the same time as the failure
  // headline, instead of having to tap "Diagnose" first.
  useEffect(() => {
    if (!bleConnected) return;
    let cancelled = false;
    setProbe({ kind: 'running' });
    void (async () => {
      try {
        const result = await onProbe();
        if (cancelled) return;
        if (result) setProbe({ kind: 'done', result });
        else
          setProbe({ kind: 'error', message: 'No diagnostic data returned.' });
      } catch (err) {
        if (cancelled) return;
        setProbe({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
    // We deliberately run this once on mount: re-running on retry
    // happens through the parent rebuilding the FailedView (the user
    // taps "Try again" → phase=`pin` → next failure → fresh mount).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bleConnected]);

  const probeSummary =
    probe.kind === 'done' ? summarizeProbeResult(probe.result) : null;
  const humanError = humanizeWifiError(rawError);
  const headline = probeSummary?.headline ?? humanError.headline;
  const subline = probeSummary?.hint ?? null;

  return (
    <Stack alignItems="center" spacing={2.5} sx={{ width: '100%' }}>
      <ErrorOutlineIcon sx={{ fontSize: 64, color: 'error.main' }} />
      <Typography
        sx={{
          fontSize: TYPO.lg,
          fontWeight: FONT_WEIGHT.semibold,
          textAlign: 'center',
        }}
      >
        {headline}
      </Typography>
      {subline && (
        <Typography
          sx={{
            fontSize: TYPO.sm,
            color: 'text.secondary',
            textAlign: 'center',
          }}
        >
          {subline}
        </Typography>
      )}

      {probe.kind === 'running' && (
        <Stack
          direction="row"
          alignItems="center"
          spacing={1.25}
          sx={{
            py: 1.25,
            px: 2,
            borderRadius: 2,
            bgcolor: 'action.hover',
            color: 'text.secondary',
            width: '100%',
            maxWidth: 320,
          }}
        >
          <CircularProgress size={14} />
          <Typography sx={{ fontSize: TYPO.xs }}>
            Diagnosing the network…
          </Typography>
        </Stack>
      )}
      {probe.kind === 'done' && <DiagnosticReport result={probe.result} />}
      {probe.kind === 'error' && (
        <Box
          sx={{
            py: 1.25,
            px: 2,
            borderRadius: 2,
            bgcolor: 'action.hover',
            color: 'text.secondary',
            textAlign: 'center',
            width: '100%',
            maxWidth: 320,
          }}
        >
          <Typography sx={{ fontSize: TYPO.xs }}>
            Diagnostic failed: {probe.message}
          </Typography>
        </Box>
      )}

      {humanError.raw && humanError.recognised && (
        <Stack alignItems="center" sx={{ width: '100%', maxWidth: 320 }}>
          <Button
            size="small"
            variant="text"
            onClick={() => setDetailsOpen((o) => !o)}
            sx={{ textTransform: 'none', alignSelf: 'center' }}
          >
            {detailsOpen ? 'Hide details' : 'Show details'}
          </Button>
          <Collapse in={detailsOpen} sx={{ width: '100%' }}>
            <Box
              sx={{
                mt: 0.5,
                py: 1.25,
                px: 2,
                borderRadius: 2,
                bgcolor: 'action.hover',
                color: 'text.secondary',
                width: '100%',
              }}
            >
              <Typography
                sx={{
                  fontSize: TYPO.xs,
                  fontFamily: 'monospace',
                  wordBreak: 'break-word',
                }}
              >
                {humanError.raw}
              </Typography>
            </Box>
          </Collapse>
        </Stack>
      )}
      {humanError.raw && !humanError.recognised && (
        <Box
          sx={{
            py: 1.25,
            px: 2,
            borderRadius: 2,
            bgcolor: 'action.hover',
            color: 'text.secondary',
            width: '100%',
            maxWidth: 320,
          }}
        >
          <Typography
            sx={{
              fontSize: TYPO.xs,
              fontFamily: 'monospace',
              wordBreak: 'break-word',
            }}
          >
            {humanError.raw}
          </Typography>
        </Box>
      )}

      <Stack
        direction="row"
        spacing={1.5}
        flexWrap="wrap"
        justifyContent="center"
      >
        <Button onClick={onBack}>Cancel</Button>
        <Button variant="contained" onClick={onRetry}>
          Try again
        </Button>
      </Stack>
    </Stack>
  );
}

/** Renders one row per probe with an icon and the daemon's status
 * verbatim. The order matches the network stack top-down (link layer
 * first), so the user reads the failure point without parsing.
 */
function DiagnosticReport({ result }: { result: WifiProbeResult }) {
  const rows: Array<{
    key: keyof WifiProbeResult;
    label: string;
    hint: string;
  }> = [
    { key: 'wlan', label: 'Wi-Fi link', hint: 'wlan0 up + has IP' },
    { key: 'gateway', label: 'Router', hint: 'default gateway reachable' },
    { key: 'dns', label: 'DNS', hint: 'name resolution works' },
    { key: 'internet', label: 'Internet', hint: 'huggingface.co responds' },
    { key: 'daemon', label: 'Daemon', hint: 'local FastAPI process up' },
  ];
  return (
    <Stack
      spacing={0.75}
      sx={{
        width: '100%',
        maxWidth: 320,
        py: 1.5,
        px: 2,
        borderRadius: 2,
        bgcolor: 'action.hover',
      }}
    >
      <Typography sx={{ fontSize: TYPO.xs, fontWeight: FONT_WEIGHT.semibold }}>
        Diagnostic
      </Typography>
      {rows.map((row) => (
        <DiagnosticRow
          key={row.key}
          label={row.label}
          hint={row.hint}
          status={result[row.key]}
        />
      ))}
    </Stack>
  );
}

function DiagnosticRow({
  label,
  hint,
  status,
}: {
  label: string;
  hint: string;
  status: string;
}) {
  // `ok` is the only universally-positive value. `timeout` and the
  // `unknown` placeholder we coerce client-side both render as
  // "warning" (yellow / hourglass) so the user can tell apart "we
  // tried and it failed" from "we couldn't tell".
  const variant: 'ok' | 'fail' | 'pending' =
    status === 'ok'
      ? 'ok'
      : status === 'timeout' || status === 'unknown'
        ? 'pending'
        : 'fail';
  const Icon =
    variant === 'ok'
      ? CheckCircleIcon
      : variant === 'pending'
        ? HourglassEmptyIcon
        : CancelIcon;
  const color =
    variant === 'ok'
      ? 'success.main'
      : variant === 'pending'
        ? 'warning.main'
        : 'error.main';
  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1.25}
      sx={{ width: '100%' }}
    >
      <Icon sx={{ fontSize: 18, color }} />
      <Stack sx={{ minWidth: 0, flex: 1 }}>
        <Typography sx={{ fontSize: TYPO.sm, fontWeight: FONT_WEIGHT.medium }}>
          {label}
        </Typography>
        <Typography
          sx={{ fontSize: TYPO.xs, color: 'text.secondary' }}
          noWrap
        >
          {hint}
        </Typography>
      </Stack>
      <Typography
        sx={{
          fontSize: TYPO.xs,
          fontFamily: 'monospace',
          color,
          textTransform: 'lowercase',
        }}
      >
        {status}
      </Typography>
    </Stack>
  );
}
