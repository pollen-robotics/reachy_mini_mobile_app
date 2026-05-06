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
 *
 * Layout
 * ──────
 * The outer `<Stack>` escapes its host column (`maxWidth: 420`
 * inside a `Stack px: 3`) via the `calc(50% - 50vw)` trick, so
 * three things span the entire viewport:
 *
 *   1. the sub-header's bottom divider (chrome-band feel),
 *   2. the scrollable area (native scrollbar lands flush with the
 *      phone edge),
 *   3. any future full-bleed UI we'd want here (search bar, …).
 *
 * Inside the bled-out column, every content row (header, hint,
 * scroll wrapper) re-applies the same `maxWidth: contentMaxWidth +
 * mx: 'auto'` constraint, so the title, the empty-state hints and
 * the cards are all aligned on one centred column with a 24px
 * gutter.
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
import { FONT_WEIGHT, LAYOUT, TYPO } from '../../styles/tokens';

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

/**
 * Shared `sx` that re-constrains a row to the centred content
 * column. Used by the sub-header, the empty-state hints and the
 * scroll wrapper so they all line up on one vertical axis.
 */
const COLUMN_SX = {
  width: '100%',
  maxWidth: LAYOUT.contentMaxWidth,
  mx: 'auto',
  px: 3,
} as const;

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
    <Stack
      sx={{
        flex: 1,
        minHeight: 0,
        // Full-bleed escape hatch. The host column caps at
        // `LAYOUT.contentMaxWidth` and centers via `mx: 'auto'`,
        // and the host `Stack` has `px: 3`. This pair pulls us
        // back out to the viewport edges so the sub-header divider
        // and the scrollbar both land flush with the phone border,
        // independent of any ancestor constraint. Each child below
        // re-applies the column constraints via `COLUMN_SX`.
        width: '100vw',
        mx: 'calc(50% - 50vw)',
        // Cancel the host column's `pt: 2` so the sub-header's
        // top divider sits flush against the screen's top bar
        // chrome (chrome-on-chrome continuity).
        mt: -2,
      }}
    >
      <SubHeader
        title="Apps"
        subtitle={
          hasError
            ? "Couldn't reach the Hub"
            : isLoading && apps.length === 0
              ? 'Fetching catalog…'
              : `${apps.length} app${apps.length === 1 ? '' : 's'} available`
        }
        action={
          <IconButton
            size="small"
            color="primary"
            aria-label="Refresh apps catalog"
            onClick={() => void refresh()}
            disabled={isLoading}
          >
            {isLoading ? (
              <CircularProgress size={16} color="primary" />
            ) : (
              <RefreshIcon fontSize="small" />
            )}
          </IconButton>
        }
      />

      {state.kind === 'loading' && apps.length === 0 ? (
        <Box sx={{ ...COLUMN_SX, pt: 1.5 }}>
          <CenteredHint>
            <CircularProgress size={20} />
            <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary' }}>
              Asking the Hub for available apps…
            </Typography>
          </CenteredHint>
        </Box>
      ) : state.kind === 'error' && apps.length === 0 ? (
        <Box sx={{ ...COLUMN_SX, pt: 1.5 }}>
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
        </Box>
      ) : apps.length === 0 ? (
        <Box sx={{ ...COLUMN_SX, pt: 1.5 }}>
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
        </Box>
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
            pt: 3,
          }}
        >
          <Box
            sx={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              // Re-apply the column constraint so the cards align
              // perfectly with the sub-header above. On phones the
              // viewport is narrower than `contentMaxWidth`, so
              // this collapses to full width and the per-item
              // padding below provides the 24px gutter.
              width: '100%',
              maxWidth: LAYOUT.contentMaxWidth,
              mx: 'auto',
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
                    // 24px gutter on each side so the card borders
                    // never touch the column edge. Matches the
                    // sub-header's `px: 3`.
                    px: 3,
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

/**
 * Sub-header chrome for a tab body.
 *
 * Bottom divider spans the full viewport (the parent is bled out)
 * for the same chrome-band feel as the screen's top bar; the title
 * + subtitle + action sit on the same centred column as the body
 * content below.
 */
function SubHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle: string;
  action?: React.ReactNode;
}) {
  return (
    <Box
      sx={(theme) => ({
        flexShrink: 0,
        borderBottom: `1px solid ${theme.palette.divider}`,
      })}
    >
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ ...COLUMN_SX, py: 1.25, minHeight: 56 }}
      >
        <Stack sx={{ minWidth: 0, flex: 1 }}>
          <Typography
            sx={{
              fontSize: TYPO.lg,
              fontWeight: FONT_WEIGHT.semibold,
              color: 'text.primary',
            }}
          >
            {title}
          </Typography>
          <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary' }} noWrap>
            {subtitle}
          </Typography>
        </Stack>
        {action}
      </Stack>
    </Box>
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
