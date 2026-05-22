/**
 * Apps tab body.
 *
 * Reachy Mini app store, mobile flavour. Driven by the redesign
 * spec in `docs/APPS_TAB_REDESIGN.md`.
 *
 * Three rendering modes, all hosted on a single scrollable
 * surface so navigation feels stateless and the launch-iframe
 * contract (`onOpen(app)`) is the only outward effect:
 *
 *   1. Browse  - default. Pinned panel (omitted when empty) +
 *                search panel + per-category horizontal rails,
 *                each panel separated by a thin bottom divider
 *                so the rhythm reads as a stack of sub-headers.
 *   2. Search  - active as soon as the input has any non-empty
 *                trimmed value. Pinned + rails collapse, the
 *                body becomes a flat result list.
 *   3. Focus   - opened when the user taps "See ›" on a category
 *                rail. Drills down into a single category as a
 *                vertical list, no other rails visible. A back
 *                chevron in a thin in-body header returns to
 *                Browse.
 *
 * Layout convention is shared with the Robot tab: the parent
 * `Stack` escapes the host column constraints via the `100vw`
 * + `calc(50% - 50vw)` trick so each panel divider spans the
 * entire viewport. Inside each panel, content is re-constrained
 * to the centred column via `COLUMN_SX`.
 *
 * Categorisation is server-driven (`/api/js-apps` returns the
 * `categories: string[] \| null` array per app, classified by an
 * LLM on the website Space). The mobile build embeds only a
 * passive taxonomy mirror (`categoryTaxonomy.ts`) for display
 * metadata. See `docs/APPS_TAB_REDESIGN.md`, Section 5.
 */
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  InputAdornment,
  Snackbar,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import ArrowBackIosNewIcon from '@mui/icons-material/ArrowBackIosNew';
import CloseIcon from '@mui/icons-material/Close';
import SearchIcon from '@mui/icons-material/Search';
import StarOutlineIcon from '@mui/icons-material/StarOutline';

import ReachiesCarousel from '@/ui/widgets/reachies-carousel/ReachiesCarousel';

import type { AppEntry } from '@/features/apps/types';
import { useApps } from '@/features/apps/useApps';
import { useFilteredApps } from '@/features/apps/useFilteredApps';
import { useHiddenAuthors } from '@/features/apps/useHiddenAuthors';
import { MAX_PINNED, usePinnedApps } from '@/features/apps/usePinnedApps';
import { FONT_WEIGHT, LAYOUT, RADIUS, TYPO } from '@/ui/design/tokens';

import AppCompactTile from './AppCompactTile';
import AppPinnedTile from './AppPinnedTile';
import AppRail from './AppRail';

interface AppsTabViewProps {
  onOpen: (app: AppEntry) => void;
}

/**
 * Vertical gap between consecutive cards in the search-results
 * and category-focus lists. The tile is content-driven (no fixed
 * height) so the gap is the only thing controlling the rhythm
 * between rows.
 */
const LIST_ROW_GAP_PX = 12;

/**
 * Shared `sx` that re-constrains a row to the centred content
 * column. Used by every panel inside a full-bleed wrapper so
 * panel content (titles, search input, list rows) lines up on
 * one vertical axis even though the dividers themselves span
 * the whole viewport.
 */
const COLUMN_SX = {
  width: '100%',
  maxWidth: LAYOUT.contentMaxWidth,
  mx: 'auto',
  px: 3,
} as const;

/**
 * Shared min-height for the pinned panel header row (label on the
 * left, `Edit` button on the right). The number is dictated by the
 * outlined `Button size="small"` we render on the right - its
 * actual rendered height is `fontSize × lineHeight + 2 × py +
 * 2 × border` ≈ 12 × 1.4 + 4 + 2 = ~23 px. We round to 28 to give
 * the chip a touch of vertical breathing room AND a clean rhythm
 * with the 8 px design grid.
 *
 * The `IntroPanel` (empty state) reserves the SAME min-height for
 * its phantom header so the "no pins → first pin" transition keeps
 * the body's vertical rhythm pixel-stable. Without this, the
 * intro panel sits ~12 px shorter than the pinned panel and the
 * whole rail stack underneath jumps as soon as the user pins
 * their first app.
 */
const PINNED_HEADER_MIN_HEIGHT = 28;

/**
 * Visual rhythm: the upper "chrome" panels (Pinned/Intro,
 * Search, focused-category header) carry a thin bottom divider
 * so the tab top reads as a vertical stack of sub-headers. The
 * category rails below are intentionally divider-less - they
 * already self-delimit via their `LABEL · count` headers + the
 * tile rows, and stacking dividers between every rail made the
 * scroll feel choppy.
 */
const PANEL_SX = {
  py: 2,
  borderBottom: (theme: { palette: { divider: string } }) =>
    `1px solid ${theme.palette.divider}`,
} as const;

const RAIL_PANEL_SX = {
  pt: 3,
  pb: 0,
} as const;

export default function AppsTabView({ onOpen }: AppsTabViewProps) {
  const { state, refresh } = useApps();
  const hiddenAuthors = useHiddenAuthors();

  // Strip apps whose author the user has hidden BEFORE any
  // downstream pass (search, categorisation, pinned reconciliation,
  // count/header strings). Doing it here means every consumer sees
  // a coherent post-filter view; doing it inside `useFilteredApps`
  // would still leave `state.apps.length` and the pinned reconciler
  // peeking at hidden entries. The filter is identity-stable
  // when the hidden set hasn't changed (memoized) so React's
  // bail-out skips the deeper work on unrelated re-renders.
  const apps = useMemo<AppEntry[]>(() => {
    if (hiddenAuthors.set.size === 0) return state.apps;
    return state.apps.filter((app) => !hiddenAuthors.isHidden(app.author));
  }, [state.apps, hiddenAuthors]);

  const isLoading = state.kind === 'loading';
  const hasError = state.kind === 'error';

  // Search query is owned here. Deferred via React 18's
  // `useDeferredValue` so the input stays buttery while the
  // filtering pass on a few dozen apps catches up. At our scale
  // it's effectively instant, but the deferral is the right
  // primitive when the catalog grows.
  const [searchQuery, setSearchQuery] = useState('');
  const deferredQuery = useDeferredValue(searchQuery);

  // Drill-down state: when set, the body renders the single
  // category's flat list instead of the browse layout.
  const [focusedCategoryId, setFocusedCategoryId] = useState<string | null>(null);

  const pinnedApps = usePinnedApps();

  const filtered = useFilteredApps({
    apps,
    searchQuery: deferredQuery,
    pinnedIds: pinnedApps.set,
  });

  // Snackbar for the cap-reached toast. The toggle handler
  // signals rejection by returning `false` even though the id
  // is not currently pinned.
  const [snackbar, setSnackbar] = useState<string | null>(null);

  const handleTogglePin = useCallback(
    (app: AppEntry) => {
      const wasPinned = pinnedApps.set.has(app.id);
      const ok = pinnedApps.toggle(app.id);
      if (!wasPinned && !ok) {
        setSnackbar(`You can pin up to ${MAX_PINNED} apps. Unpin one first.`);
      }
    },
    [pinnedApps],
  );

  // Derived current focused bucket (null in browse / search modes).
  const focusedBucket = useMemo(() => {
    if (!focusedCategoryId) return null;
    return filtered.rails.find((r) => r.descriptor.id === focusedCategoryId) ?? null;
  }, [focusedCategoryId, filtered.rails]);

  // Auto-exit focus mode when the focused category vanishes (e.g.
  // catalog refresh emptied that bucket). Avoids a stale empty
  // sub-page that the user can't escape via the rail's "See ›".
  useEffect(() => {
    if (focusedCategoryId && !focusedBucket) {
      setFocusedCategoryId(null);
    }
  }, [focusedCategoryId, focusedBucket]);

  const flatList: AppEntry[] = focusedBucket
    ? focusedBucket.apps
    : filtered.isSearching
      ? filtered.searchResults
      : [];

  const showFlatList = focusedBucket !== null || filtered.isSearching;

  // Initial empty / loading / error states. Rendered inside the
  // scroll container so they share the panel rhythm without
  // needing a dedicated chrome above.
  const initialPlaceholder = (() => {
    if (isLoading && apps.length === 0) {
      return (
        <Box sx={{ ...COLUMN_SX, pt: 4, pb: 4 }}>
          <CenteredHint>
            <CircularProgress size={20} />
            <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary' }}>
              Asking the Hub for available apps…
            </Typography>
          </CenteredHint>
        </Box>
      );
    }
    if (hasError && apps.length === 0) {
      return (
        <Box sx={{ ...COLUMN_SX, pt: 4, pb: 4 }}>
          <CenteredHint>
            <Typography sx={{ fontSize: TYPO.sm, fontWeight: FONT_WEIGHT.medium }}>
              Couldn't reach the Hub
            </Typography>
            <Typography
              sx={{ fontSize: TYPO.xs, color: 'text.secondary', textAlign: 'center' }}
            >
              {state.kind === 'error' ? state.reason : ''}
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
      );
    }
    if (apps.length === 0) {
      return (
        <Box sx={{ ...COLUMN_SX, pt: 4, pb: 4 }}>
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
      );
    }
    return null;
  })();

  return (
    <Stack
      sx={{
        flex: 1,
        minHeight: 0,
        // Full-bleed escape hatch: pulled back out to the viewport
        // edges so panel dividers and rails span flush to the
        // phone border, independent of any ancestor constraint.
        // Each panel below re-applies `COLUMN_SX` to its content.
        width: '100vw',
        mx: 'calc(50% - 50vw)',
        // The body owns its own padding/dividers entirely; we
        // clip horizontal overflow because some children (rails)
        // intentionally spill beyond the viewport edge to host
        // their internal scroll track.
        overflow: 'hidden',
      }}
    >
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          // Pad the bottom so the last panel's divider isn't
          // hugged by the BottomNavigation - the host doesn't add
          // bottom padding to its main column to keep the bottom
          // nav full-bleed.
          pb: 2,
        }}
      >
        {initialPlaceholder ?? (
          <>
            {/* Focused-category header: a thin in-body sub-header
                with a back chevron + label + count. Replaces the
                old sub-header chrome we used to render above the
                body. */}
            {focusedBucket && (
              <Box sx={PANEL_SX}>
                <Stack
                  direction="row"
                  alignItems="center"
                  spacing={1}
                  sx={{ ...COLUMN_SX, py: 0.25, minHeight: 36 }}
                >
                  <IconButton
                    size="small"
                    aria-label="Back to apps"
                    onClick={() => setFocusedCategoryId(null)}
                    sx={{ ml: -0.5 }}
                  >
                    <ArrowBackIosNewIcon sx={{ fontSize: TYPO.md }} />
                  </IconButton>
                  <Stack sx={{ minWidth: 0, flex: 1 }}>
                    <Typography
                      sx={{
                        fontSize: TYPO.body,
                        fontWeight: FONT_WEIGHT.semibold,
                        color: 'text.primary',
                      }}
                    >
                      {focusedBucket.descriptor.label}
                    </Typography>
                    <Typography
                      sx={{ fontSize: TYPO.tiny, color: 'text.secondary' }}
                    >
                      {focusedBucket.apps.length} app
                      {focusedBucket.apps.length === 1 ? '' : 's'}
                    </Typography>
                  </Stack>
                </Stack>
              </Box>
            )}

            {/* Browse panels: pinned + search + per-category rails.
                Each lives in its own bottom-divider panel. */}
            {!focusedBucket && (
              <>
                {pinnedApps.ids.length > 0 && filtered.pinned.length > 0 ? (
                  <Box sx={PANEL_SX}>
                    <PinnedGrid
                      apps={filtered.pinned}
                      recentlyAddedId={pinnedApps.recentlyAddedId}
                      onOpen={onOpen}
                      onUnpin={(app) => pinnedApps.unpin(app.id)}
                    />
                  </Box>
                ) : (
                  // Intro slot: occupies the same panel position
                  // the pinned grid would fill, sized to match
                  // the visual weight of one pinned-row + label
                  // so the body's vertical rhythm is unchanged
                  // before/after the user pins their first app.
                  <Box sx={PANEL_SX}>
                    <IntroPanel />
                  </Box>
                )}

                {/* Search panel: sticky once it scrolls to the
                    top of the body. The `position: sticky` works
                    because the panel is a direct child of the
                    scroll container above. The `bgcolor` on the
                    panel hides the rails sliding underneath while
                    the bar is pinned. The vertical padding here
                    overrides `PANEL_SX.py` (2 → 4) so the search
                    panel has more breathing room top + bottom
                    than the surrounding pinned / rails panels.
                 */}
                <Box
                  sx={{
                    ...PANEL_SX,
                    py: 3,
                    position: 'sticky',
                    top: 0,
                    zIndex: 2,
                    bgcolor: 'background.default',
                  }}
                >
                  {/* Tighter horizontal gutter than the rest of
                      the column (16 px instead of the default
                      24 px from `COLUMN_SX`). The search input is
                      an outlined `<TextField>`, which has its own
                      internal padding between the border rectangle
                      and the placeholder text - if we kept the
                      24 px wrapper, the visible left edge of the
                      searchbar border ends up sitting visually
                      "further in" than the first tile in the
                      rails below. Pulling the wrapper to 16 px
                      compensates so the border edge of the search
                      box lines up with the rail tiles below. */}
                  <Box sx={{ ...COLUMN_SX, px: 2 }}>
                    <SearchInput
                      value={searchQuery}
                      onChange={setSearchQuery}
                      total={apps.length}
                    />
                  </Box>
                </Box>

                {/* Browse rails. Hidden during search mode (the
                    search results take over the body). The bucket
                    size is rendered next to the label so the user
                    knows how many apps live in each rail at a
                    glance. Sparse buckets (< MIN_RAIL_SIZE) were
                    already filtered out by `useFilteredApps`. */}
                {!filtered.isSearching &&
                  filtered.rails.map((bucket) => (
                    <Box key={bucket.descriptor.id} sx={RAIL_PANEL_SX}>
                      <AppRail
                        label={bucket.descriptor.label}
                        count={bucket.apps.length}
                        onSeeAll={() =>
                          setFocusedCategoryId(bucket.descriptor.id)
                        }
                      >
                        {bucket.apps.map((app) => (
                          <AppCompactTile
                            key={app.id}
                            app={app}
                            isPinned={pinnedApps.set.has(app.id)}
                            onOpen={onOpen}
                            onTogglePin={handleTogglePin}
                          />
                        ))}
                      </AppRail>
                    </Box>
                  ))}
              </>
            )}

            {/* Search-mode summary chip: shows result count and a
                clear hint. Mounted only when the user typed something. */}
            {!focusedBucket && filtered.isSearching && (
              <Box sx={{ ...COLUMN_SX, pt: 2, pb: 1 }}>
                <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary' }}>
                  {filtered.searchResults.length === 0
                    ? `No apps match "${searchQuery.trim()}".`
                    : `${filtered.searchResults.length} result${
                        filtered.searchResults.length === 1 ? '' : 's'
                      }`}
                </Typography>
              </Box>
            )}

            {focusedBucket && <Box sx={{ ...COLUMN_SX, pt: 2, pb: 1 }} />}

            {/* Flat list of `AppCompactTile`s in `fullWidth` mode.
                Mounted only in search and category-focus modes
                (browse mode has no trailing list - sparse-bucket
                apps surface via search). The tile is
                content-driven, so the gap between rows is the
                only thing controlling the rhythm. We don't
                virtualise: the catalog is small enough that
                rendering all matches outright is cheaper than
                the bookkeeping a virtualizer would require for
                content-variable rows. */}
            {showFlatList && (
              <Stack
                spacing={`${LIST_ROW_GAP_PX}px`}
                sx={{
                  ...COLUMN_SX,
                }}
              >
                {flatList.map((app) => (
                  <AppCompactTile
                    key={app.id}
                    app={app}
                    isPinned={pinnedApps.set.has(app.id)}
                    onOpen={onOpen}
                    onTogglePin={handleTogglePin}
                    fullWidth
                  />
                ))}
              </Stack>
            )}
          </>
        )}
      </Box>

      <Snackbar
        open={snackbar !== null}
        autoHideDuration={3500}
        onClose={() => setSnackbar(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        sx={{ bottom: { xs: 88, sm: 88 } }}
      >
        <Alert
          severity="info"
          variant="filled"
          onClose={() => setSnackbar(null)}
          sx={{ fontSize: TYPO.sm }}
        >
          {snackbar}
        </Alert>
      </Snackbar>
    </Stack>
  );
}

// ===========================================================================
// Sub-components (file-local; not exported)
// ===========================================================================

/**
 * Intro panel: replaces the pinned grid until the user has at
 * least one pinned app. Sized to mirror the visual weight of a
 * pinned panel with a single row (label + one tile + caption)
 * so the body's vertical rhythm is unchanged whether or not the
 * user has pinned anything yet.
 *
 * Layout:
 *
 *   ┌──────────┐
 *   │          │   "Discover apps for your Reachy Mini."
 *   │    ✨    │
 *   │          │   Tap the ★ on any app to pin it here for
 *   └──────────┘   quick access.
 *
 * The icon-box on the left has the same dimensions as a pinned
 * tile (`(100% - 24px) / 3` wide, square). The text on the
 * right runs two paragraphs: the hero one-liner and the affordance
 * education.
 */
function IntroPanel() {
  return (
    <Box sx={COLUMN_SX}>
      {/* Phantom header. The earlier draft rendered an
          "Apps · {count}" label here; we dropped the chrome
          because the count is implicit (rails carry their own
          counts) and the label was just adding noise on a
          surface that's already heavy with copy. The phantom
          element preserves the panel height so the transition
          to the pinned panel (which DOES have a "Pinned · N"
          label + outlined `Edit` chip) is seamless: the body's
          vertical rhythm stays identical whether or not the
          user has pinned anything.
          ────────────────
          We size with `minHeight: PINNED_HEADER_MIN_HEIGHT`
          (NOT a `<Typography>` of TYPO.tiny which only renders
          ~12 px tall), so the phantom matches the actual rendered
          height of the pinned panel's `Edit` outlined chip
          (~23 px). Without this match, pinning the first app made
          the body jump ~12 px - the whole rail stack underneath
          shifted at the exact moment the user looked at their
          new pin, which read as a UI glitch. */}
      <Box
        aria-hidden
        sx={{
          mb: 1.5,
          minHeight: PINNED_HEADER_MIN_HEIGHT,
        }}
      />


      <Stack direction="row" spacing={1.5} alignItems="stretch">
        {/* Hero column. Mirrors the structure of a single
            `AppPinnedTile` exactly (square glyph + caption line)
            so the IntroPanel's height matches a pinned panel
            with one row of pins, pixel-for-pixel. The transition
            "no pins → first pin" then swaps the panel content
            without any vertical jump. */}
        <Box
          aria-hidden
          sx={{
            flexShrink: 0,
            // Match the pinned grid's column width pixel-for-pixel
            // so the hero illustration occupies the same slot a
            // single pinned tile would. The grid uses
            // `repeat(3, minmax(0, 1fr))` with `columnGap: 3`
            // (24 px), so each cell is `(100% - 2 × 24px) / 3`.
            width: 'calc((100% - 48px) / 3)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'stretch',
            minWidth: 0,
          }}
        >
          {/* Square glyph - identical geometry to the pinned tile
              glyph (`width: 100%, aspectRatio: 1 / 1`). The
              carousel fills it 100 %, with `overflow: hidden`
              clipping the carousel's `scale > 1` zoom. No border
              and no background fill: the artwork carries the
              entire visual weight, and the absence of chrome
              makes the hero feel lighter than a pinned tile
              even at the same dimensions. */}
          <Box
            sx={{
              width: '100%',
              aspectRatio: '1 / 1',
              overflow: 'hidden',
              boxSizing: 'border-box',
            }}
          >
            <ReachiesCarousel zoom={1.4} verticalAlign="60%" />
          </Box>
          {/* Phantom caption: same metrics as `AppPinnedTile`'s
              name caption (`mt: 0.75`, `fontSize: TYPO.tiny`,
              `lineHeight: 1.2`) but invisible. Reserves the
              vertical room so this column has the exact height
              of a real pinned tile + name. The non-breaking
              space prevents the line from collapsing. */}
          <Typography
            sx={{
              mt: 0.75,
              fontSize: TYPO.tiny,
              fontWeight: FONT_WEIGHT.medium,
              lineHeight: 1.2,
              visibility: 'hidden',
            }}
          >
            &nbsp;
          </Typography>
        </Box>

        <Stack
          spacing={1}
          sx={{ flex: 1, minWidth: 0, justifyContent: 'center' }}
        >
          <Typography
            sx={{
              fontSize: TYPO.xxl,
              fontWeight: FONT_WEIGHT.bold,
              color: 'text.primary',
              letterSpacing: '-0.4px',
              lineHeight: 1.15,
            }}
          >
            Discover apps
          </Typography>
          <Typography
            sx={{
              fontSize: TYPO.body,
              color: 'text.secondary',
              lineHeight: 1.45,
            }}
          >
            Tap the{' '}
            <Box
              component="span"
              sx={{
                display: 'inline-flex',
                verticalAlign: '-5px',
              }}
            >
              <StarOutlineIcon sx={{ fontSize: 22 }} />
            </Box>{' '}
            on any app to pin it here for quick access.
          </Typography>
        </Stack>
      </Stack>
    </Box>
  );
}

/**
 * Pinned panel: a fixed 3-column grid of `AppPinnedTile`s, in
 * insertion order. Diverges from the horizontal-rail pattern used
 * by the thematic categories: pinned apps are a "dock" the user
 * curates, so a stable grid that doesn't require horizontal scroll
 * is more legible than a strip. Cap of 12 (`MAX_PINNED`) means at
 * most 4 rows.
 *
 * The header reuses the same "LABEL · N" rhythm as the category
 * rails so the panel feels of a piece with the rest of the body
 * even though the inner layout is different.
 *
 * Pop-in animation:
 *   - Driven by `recentlyAddedId`, sourced from `usePinnedApps`
 *     so the signal survives this component's mount/unmount.
 *     The first pin in a session transitions the IntroPanel away
 *     and mounts this grid fresh; without a hook-level signal
 *     the grid would have no notion of "this id just landed".
 *   - When `recentlyAddedId === app.id`, the matching tile renders
 *     with `isNew={true}` and plays its pop-in keyframe. Every
 *     other tile mounts statically.
 *   - The hook auto-resets the signal after ~500 ms (just past
 *     the animation budget), so a tab-switch round-trip during
 *     the animation doesn't lose it mid-flight, and a stale
 *     value can't trigger a phantom replay.
 */
function PinnedGrid({
  apps,
  recentlyAddedId,
  onOpen,
  onUnpin,
}: {
  apps: AppEntry[];
  recentlyAddedId: string | null;
  onOpen: (app: AppEntry) => void;
  onUnpin: (app: AppEntry) => void;
}) {
  // Edit mode toggles the iOS-style "jiggle" UX on every tile:
  // each one sprouts a ✕ badge in its top-left corner and starts
  // a subtle wiggle to signal "tap me to remove". Local state
  // because the affordance has no meaning outside this panel,
  // and we want it to auto-reset on tab switch (the grid
  // unmounts and the next visit starts in the clean read mode).
  const [editMode, setEditMode] = useState(false);

  // Auto-exit when the grid empties out: with no tiles left,
  // "Done" would dangle next to a 0-count header. We also leave
  // edit mode the moment the cap hits 0, even if the user emptied
  // it via the star toggles on compact tiles elsewhere (cross-panel
  // unpins still trickle in via `useFilteredApps` → `apps`).
  useEffect(() => {
    if (apps.length === 0 && editMode) {
      setEditMode(false);
    }
  }, [apps.length, editMode]);

  return (
    <Box sx={COLUMN_SX}>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ mb: 1.5, minHeight: PINNED_HEADER_MIN_HEIGHT }}
      >
        <Typography
          sx={{
            fontSize: TYPO.tiny,
            fontWeight: FONT_WEIGHT.semibold,
            color: 'text.secondary',
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            lineHeight: 1.1,
          }}
        >
          Pinned apps
          <Box
            component="span"
            sx={{ opacity: 0.6, fontWeight: FONT_WEIGHT.medium, ml: 0.75 }}
          >
            · {apps.length}
          </Box>
        </Typography>
        {/* Edit / Done toggle. Sentence-case (not uppercase) so the
            user's primary path "tap Edit" reads as a verb rather
            than a label; it sits visually heavier than the
            "PINNED APPS" header letterform so the eye finds it
            quickly once the user is hunting for a way to remove
            a pin. Mounted unconditionally - even with a single
            pin, the user might want to remove it - so the
            affordance is always there from pin #1 onward. */}
        <Button
          variant="outlined"
          color="primary"
          size="small"
          onClick={() => setEditMode((prev) => !prev)}
          aria-pressed={editMode}
          aria-label={editMode ? 'Done editing pinned apps' : 'Edit pinned apps'}
          sx={{
            flexShrink: 0,
            fontSize: TYPO.xs,
            fontWeight: FONT_WEIGHT.semibold,
            // Sentence-case label - keep it as a verb the user
            // recognises, not a SCREAMING button.
            textTransform: 'none',
            // Tight padding so the chip-style button fits the
            // panel header rhythm without dwarfing the
            // "PINNED APPS" label on its left.
            minWidth: 0,
            lineHeight: 1.4,
            px: 1.25,
            py: 0.25,
          }}
        >
          {editMode ? 'Done' : 'Edit'}
        </Button>
      </Stack>
      <Box
        sx={{
          display: 'grid',
          // `minmax(0, 1fr)` (not bare `1fr`) so a tile with a
          // long caption can't push its column wider than 1/3 of
          // the row. Bare `1fr` resolves its lower bound to
          // `auto` = `min-content`, which lets a long word in
          // the caption stretch the column and break the
          // "all tiles the same size" guarantee.
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          // Column gap is intentionally generous so the dock
          // reads as discrete icons rather than a packed grid.
          // Row gap stays smaller (the captions provide their
          // own bit of breathing room before the next square).
          columnGap: 3,
          rowGap: 2,
        }}
      >
        {apps.map((app) => (
          <AppPinnedTile
            key={app.id}
            app={app}
            isNew={recentlyAddedId === app.id}
            editMode={editMode}
            onOpen={onOpen}
            onUnpin={onUnpin}
          />
        ))}
      </Box>
    </Box>
  );
}

function SearchInput({
  value,
  onChange,
  total,
}: {
  value: string;
  onChange: (v: string) => void;
  total: number;
}) {
  return (
    <TextField
      fullWidth
      // No `size` prop = MUI default ("medium"), ~52-56 px tall.
      // We keep growing it slightly past the default via the
      // input padding overrides below so the bar reads as a
      // primary input on mobile rather than a chrome filter.
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={`Search ${total} app${total === 1 ? '' : 's'}, authors...`}
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      InputProps={{
        startAdornment: (
          <InputAdornment position="start">
            <SearchIcon sx={{ fontSize: TYPO.xl, color: 'text.secondary' }} />
          </InputAdornment>
        ),
        endAdornment:
          value.length > 0 ? (
            <InputAdornment position="end">
              <IconButton
                size="small"
                aria-label="Clear search"
                onClick={() => onChange('')}
                edge="end"
              >
                <CloseIcon sx={{ fontSize: TYPO.lg }} />
              </IconButton>
            </InputAdornment>
          ) : undefined,
        sx: {
          fontSize: TYPO.md,
          borderRadius: `${RADIUS.lg}px`,
          bgcolor: 'background.paper',
          // Bump the input itself a bit so the bar feels weighty
          // enough to be the primary affordance once it pins to
          // the top of the body.
          '& input': {
            py: 1.75,
          },
        },
      }}
    />
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
