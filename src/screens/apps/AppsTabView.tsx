/**
 * Apps tab body.
 *
 * Renders the list of Reachy Mini apps fetched from the public
 * catalog (`useApps()`). The catalog has ~200 entries today and
 * keeps growing, so the list is virtualized via
 * `@tanstack/react-virtual` to keep scroll performance flat
 * regardless of size: only the visible cards (+ a small overscan)
 * are mounted at any time.
 *
 * The tab itself is a "browse" surface - selecting an app triggers
 * the host's `onOpen` which mounts the iframe overlay.
 */
import { useRef } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  Stack,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useVirtualizer } from '@tanstack/react-virtual';

import type { AppEntry } from '../../apps/types';
import { useApps } from '../../apps/useApps';
import { FONT_WEIGHT, TYPO } from '../../styles/tokens';

import AppCard from './AppCard';

interface AppsTabViewProps {
  onOpen: (app: AppEntry) => void;
}

/**
 * Estimated row height fed to the virtualizer. Includes the card's
 * own height + the inter-card gap. Cards have a clamped 2-line
 * description and a fixed-height button, so the variance is small
 * enough that a constant estimate keeps scroll math correct without
 * needing dynamic measurement.
 */
const ROW_HEIGHT_PX = 220;

export default function AppsTabView({ onOpen }: AppsTabViewProps) {
  const { state, refresh } = useApps();
  const apps = 'apps' in state ? state.apps : [];
  const isLoading = state.kind === 'loading';
  const hasError = state.kind === 'error';

  const scrollRef = useRef<HTMLDivElement | null>(null);

  // The virtualizer captures `scrollRef.current` lazily on every
  // measurement pass, so it's safe to leave it null on first render
  // (the empty / loading / error placeholders rendered before this
  // hook spins up don't need a scrollable host).
  const rowVirtualizer = useVirtualizer({
    count: apps.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    // ~3 rows of overscan keeps the user from ever seeing a blank
    // strip during fast scroll on mid-tier phones, while still
    // being small enough that the DOM stays bounded.
    overscan: 3,
  });

  return (
    <Stack spacing={1.25} sx={{ width: '100%', flex: 1, minHeight: 0 }}>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ width: '100%' }}
      >
        <Stack sx={{ minWidth: 0, flex: 1 }}>
          <Typography
            sx={{
              fontSize: TYPO.lg,
              fontWeight: FONT_WEIGHT.semibold,
              color: 'text.primary',
            }}
          >
            Apps
          </Typography>
          <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary' }} noWrap>
            {hasError
              ? "Couldn't reach the Hub"
              : isLoading && apps.length === 0
                ? 'Fetching catalog…'
                : `${apps.length} app${apps.length === 1 ? '' : 's'} available`}
          </Typography>
        </Stack>
        <IconButton
          size="small"
          aria-label="Refresh apps catalog"
          onClick={() => void refresh()}
          disabled={isLoading}
        >
          {isLoading ? (
            <CircularProgress size={16} />
          ) : (
            <RefreshIcon fontSize="small" />
          )}
        </IconButton>
      </Stack>

      {state.kind === 'loading' && apps.length === 0 ? (
        <CenteredHint>
          <CircularProgress size={20} />
          <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary' }}>
            Asking the Hub for available apps…
          </Typography>
        </CenteredHint>
      ) : state.kind === 'error' && apps.length === 0 ? (
        <CenteredHint>
          <Typography sx={{ fontSize: TYPO.sm, fontWeight: FONT_WEIGHT.medium }}>
            Couldn't reach the Hub
          </Typography>
          <Typography
            sx={{ fontSize: TYPO.xs, color: 'text.secondary', textAlign: 'center' }}
          >
            {state.reason}
          </Typography>
          <Button
            size="small"
            variant="text"
            onClick={() => void refresh()}
            sx={{ textTransform: 'none' }}
          >
            Retry
          </Button>
        </CenteredHint>
      ) : apps.length === 0 ? (
        <CenteredHint>
          <Typography sx={{ fontSize: TYPO.sm, fontWeight: FONT_WEIGHT.medium }}>
            No apps yet
          </Typography>
          <Typography
            sx={{ fontSize: TYPO.xs, color: 'text.secondary', textAlign: 'center' }}
          >
            The Reachy Mini catalog is empty - check back soon.
          </Typography>
        </CenteredHint>
      ) : (
        <Box
          ref={scrollRef}
          sx={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            // Pad the bottom so the last card isn't hugged by the
            // BottomNavigation - the host doesn't add bottom padding
            // to its main column to keep the bottom nav full-bleed.
            pb: 2,
            // Small horizontal cushion against the screen edges so
            // the cards' borders don't visually clip on narrow
            // phones (the parent column already has px: 3, so this
            // is a no-op there but keeps the component layout-safe
            // if dropped into a tighter slot later).
            px: 0,
          }}
        >
          <Box
            sx={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const app = apps[virtualRow.index];
              if (!app) return null;
              return (
                <Box
                  key={app.id}
                  data-index={virtualRow.index}
                  sx={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                    // Reserve the full estimated row height; the card
                    // itself fills minus the inter-row gap.
                    height: `${virtualRow.size}px`,
                    pb: 1,
                  }}
                >
                  <AppCard app={app} onOpen={onOpen} />
                </Box>
              );
            })}
          </Box>
        </Box>
      )}
    </Stack>
  );
}

function CenteredHint({ children }: { children: React.ReactNode }) {
  return (
    <Stack
      alignItems="center"
      spacing={1}
      sx={{
        py: 3,
        px: 2,
        borderRadius: 2,
        bgcolor: 'action.hover',
        color: 'text.secondary',
      }}
    >
      {children}
    </Stack>
  );
}
