/**
 * Apps tab body.
 *
 * Reachy Mini app store, mobile flavour. Driven by the redesign
 * spec in `docs/APPS_TAB_REDESIGN.md`.
 *
 * Two top-level views, navigated like a master/detail push:
 *
 *   - Pinned  - default landing. A 2-column launcher of big
 *               `AppLauncherCard`s (icon + name + description, the
 *               whole card opens the app) over the user's curated set,
 *               seeded with the official Pollen apps. A prominent
 *               `StoreCta` button at the bottom opens the store. See
 *               `LauncherView`.
 *   - Store   - the full catalog (search + per-category rails + the
 *               drill-down focus list). Unchanged from the original
 *               single-surface design; its three rendering modes are
 *               described below. A "Back to launcher" chevron at the
 *               top returns to the launcher (hidden while a category is
 *               drilled into - Focus owns the screen with its own
 *               back affordance).
 *
 * Store rendering modes, all hosted on a single scrollable
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
 * Categorisation is server-driven: `/api/js-apps` returns both the
 * per-app `categories: string[] | null` array (classified by an LLM
 * on the website Space) AND the live taxonomy itself under
 * `categorization.taxonomy`. The mobile shell consumes the taxonomy
 * via `resolveTaxonomy()` (label overrides + offline fallback in
 * `categoryTaxonomy.ts`); the slug list is never mirrored by hand.
 * See `docs/APPS_TAB_REDESIGN.md`, Section 5.
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  CircularProgress,
  IconButton,
  InputAdornment,
  Snackbar,
  Stack,
  TextField,
  Typography,
  alpha,
} from '@mui/material';
import ArrowBackIosNewIcon from '@mui/icons-material/ArrowBackIosNew';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded';
import CloseIcon from '@mui/icons-material/Close';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import SearchIcon from '@mui/icons-material/Search';
import StarOutlineIcon from '@mui/icons-material/StarBorder';
import StorefrontOutlinedIcon from '@mui/icons-material/StorefrontOutlined';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import AppsIcon from '@/ui/design/icons/AppsIcon';
import ReachiesCarousel from '@/ui/widgets/reachies-carousel/ReachiesCarousel';

import { resolveTaxonomy } from '@/features/apps/categoryTaxonomy';
import type { AppEntry } from '@/features/apps/types';
import { useApps } from '@/features/apps/useApps';
import { useFilteredApps } from '@/features/apps/useFilteredApps';
import { useHiddenAuthors } from '@/features/apps/useHiddenAuthors';
import { useMyApps } from '@/features/apps/useMyApps';
import { MAX_PINNED, usePinnedApps } from '@/features/apps/usePinnedApps';
import IllustratedState from '@/ui/design/IllustratedState';
import { railActionButtonSx } from '@/ui/design/railActionButtonSx';
import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';

import AppCompactTile from './AppCompactTile';
import AppCreateYourOwnTile from './AppCreateYourOwnTile';
import AppLauncherCard from './AppLauncherCard';
import AppRail from './AppRail';
import AppsCreateFooter from './AppsCreateFooter';
import LazyMount from './LazyMount';
import VirtualAppList from './VirtualAppList';
import { COLUMN_SX } from './layout';

interface AppsTabViewProps {
  onOpen: (app: AppEntry) => void;
}

/**
 * Number of tiles a browse rail renders as a *preview*. A horizontal
 * rail only ever shows ~2-3 tiles at once, so mounting a category's
 * full bucket (which can be dozens of apps once the catalog grows to
 * 200-300) just to leave them parked off-screen is pure waste - each
 * tile spins up its own TanStack like-observer + icon load. We render
 * the top-N (already sorted by likes) and route the rest through the
 * rail's existing "See all" drill-down, exactly the App Store
 * pattern. The focus list keeps the FULL bucket, so nothing is lost.
 */
const RAIL_PREVIEW_CAP = 12;

/**
 * Reserved height for a not-yet-mounted rail (`LazyMount` placeholder).
 * Approximates header + one tile row + the panel's top padding so the
 * scroll length is right before the rail hydrates; mounting happens
 * ahead of the fold so any small mismatch settles off-screen.
 */
const RAIL_PLACEHOLDER_HEIGHT = 260;

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
  borderBottom: (theme: { palette: { divider: string } }) => `1px solid ${theme.palette.divider}`,
} as const;

const RAIL_PANEL_SX = {
  pt: 4,
  pb: 0,
} as const;

// First rail sits right under the search panel's bottom divider, so it
// needs far less top margin than the inter-rail gap above.
const RAIL_PANEL_FIRST_SX = {
  pt: 2.5,
  pb: 0,
} as const;

export default function AppsTabView({ onOpen }: AppsTabViewProps) {
  const { state, refresh } = useApps();
  const hiddenAuthors = useHiddenAuthors();

  // The scrollable body. Threaded into `VirtualAppList` so the
  // windowed search / focus lists virtualise against the same
  // scroll element the rest of the tab scrolls in.
  const scrollRef = useRef<HTMLDivElement>(null);

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
    return state.apps.filter(app => !hiddenAuthors.isHidden(app.author));
  }, [state.apps, hiddenAuthors]);

  const isLoading = state.kind === 'loading';
  const hasError = state.kind === 'error';

  // First-paint gate. The catalog is usually prefetched at the App
  // root (`usePrefetchApps`), so by the time this tab mounts the
  // data is already cached and the network `loading` state never
  // shows - yet mounting the full browse tree (pinned grid +
  // intro carousel + every category rail with its tiles/icons) in
  // one synchronous pass still hitches the UI for a few hundred ms
  // on first open. We defer that heavy tree by one animation frame
  // so the spinner below paints immediately; the content then
  // mounts on the next frame, turning a frozen blank tab into a
  // clean "spinner → content" reveal. Runs once per mount, and the
  // tab stays mounted across tab switches (hidden via CSS), so this
  // cost is paid only the first time the user opens Apps.
  const [contentReady, setContentReady] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setContentReady(true));
    return () => cancelAnimationFrame(raf);
  }, []);

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

  // Top-level Apps sub-view: the curated launcher ('pinned', default)
  // vs the full store ('store'). Toggled from the bottom strip. The
  // launcher lands first so the user's apps (and the seeded official
  // ones) are the first thing they see when opening the tab.
  const [view, setView] = useState<'pinned' | 'store'>('pinned');
  const handleChangeView = useCallback((next: 'pinned' | 'store') => {
    setView(next);
    // Leaving the store drops any drill-down so coming back starts on
    // the clean browse layout (and the bottom toggle stays visible).
    if (next === 'pinned') setFocusedCategoryId(null);
  }, []);

  const pinnedApps = usePinnedApps();

  // Seed the pinned dock with the official Pollen apps the first time
  // the catalog loads. One-shot (guarded inside `seedDefaults`): once a
  // user has been seeded, their curation wins - unpinning a default
  // sticks across reloads. We pass the official ids derived from the
  // live catalog so the default set tracks whatever the server flags
  // as official, rather than a hardcoded list that would drift.
  const { seedDefaults } = pinnedApps;
  useEffect(() => {
    if (state.kind !== 'ready') return;
    const officialIds = apps.filter(app => app.isOfficial).map(app => app.id);
    seedDefaults(officialIds);
  }, [state.kind, apps, seedDefaults]);

  // "Your apps" rail data: the user's own Reachy JS apps (private
  // repos included), fetched straight from the HF Hub. Independent
  // of the public catalog above, so it stays empty for signed-out
  // users and never blocks the browse layout from rendering.
  const myApps = useMyApps();

  // Resolve the live taxonomy from the catalog payload. The server
  // ships the slug list under `categorization.taxonomy`, so the
  // mobile shell never has to mirror it by hand: a server taxonomy
  // bump (e.g. adding `games`, renaming `dance` → `motion`) takes
  // effect on the next catalog refresh, no mobile build required.
  // The resolver applies mobile-preferred label overrides
  // (`Music & Beats` → `Music`) and falls back to a typed snapshot
  // when the payload is missing (cold start, offline, pre-taxonomy
  // server build).
  const taxonomy = useMemo(
    () => resolveTaxonomy(state.categorization?.taxonomy ?? null),
    [state.categorization]
  );

  const filtered = useFilteredApps({
    apps,
    searchQuery: deferredQuery,
    pinnedIds: pinnedApps.set,
    taxonomy,
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
    [pinnedApps]
  );

  // Derived current focused bucket (null in browse / search modes).
  const focusedBucket = useMemo(() => {
    if (!focusedCategoryId) return null;
    return filtered.rails.find(r => r.descriptor.id === focusedCategoryId) ?? null;
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

  // Shared loading screen: a centered spinner that fills the tab
  // height. Shown while the heavy browse tree is still gated behind
  // the first-paint frame (`!contentReady`) AND while the catalog
  // fetch is genuinely in flight with nothing cached yet.
  const loadingScreen = (
    <FullHeightCenter>
      <Stack spacing={2} sx={{ alignItems: 'center' }}>
        <CircularProgress size={32} sx={{ color: 'grey.300' }} />
        <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary' }}>
          Loading apps…
        </Typography>
      </Stack>
    </FullHeightCenter>
  );

  const initialPlaceholder = (() => {
    if (!contentReady || (isLoading && apps.length === 0)) {
      return loadingScreen;
    }
    if (hasError && apps.length === 0) {
      return (
        <FullHeightCenter>
          <CenteredHint>
            <Typography sx={{ fontSize: TYPO.sm, fontWeight: FONT_WEIGHT.medium }}>
              Couldn't reach the Hub
            </Typography>
            <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary', textAlign: 'center' }}>
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
        </FullHeightCenter>
      );
    }
    if (apps.length === 0) {
      return (
        <FullHeightCenter>
          <CenteredHint>
            <Typography sx={{ fontSize: TYPO.sm, fontWeight: FONT_WEIGHT.medium }}>
              No apps yet
            </Typography>
            <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary', textAlign: 'center' }}>
              The Reachy Mini catalog is empty - check back soon.
            </Typography>
          </CenteredHint>
        </FullHeightCenter>
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
        ref={scrollRef}
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
        {initialPlaceholder ?? (view === 'pinned' ? (
          <LauncherView
            apps={filtered.pinned}
            recentlyAddedId={pinnedApps.recentlyAddedId}
            onOpen={onOpen}
            onUnpin={app => pinnedApps.unpin(app.id)}
            onReorder={pinnedApps.reorder}
            onBrowseStore={() => handleChangeView('store')}
          />
        ) : (
          <>
            {/* Focused-category header: a thin in-body sub-header
                with a back chevron + label + count. Replaces the
                old sub-header chrome we used to render above the
                body. */}
            {focusedBucket && (
              <Box sx={PANEL_SX}>
                <Stack
                  direction="row"
                  spacing={1}
                  sx={{
                    alignItems: 'center',
                    ...COLUMN_SX,
                    py: 0.25,
                    minHeight: 36,
                  }}
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
                    <Typography sx={{ fontSize: TYPO.tiny, color: 'text.secondary' }}>
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
                {/* Store header: folds the back affordance INTO the
                    title row (no standalone chevron row eating a whole
                    line) and carries a one-line "tap ★ to add to your
                    launcher" hint. Replaces the old illustration-heavy
                    intro panel. */}
                <Box sx={{ ...PANEL_SX, pt: 3.5, pb: 1 }}>
                  <StoreHeader onBack={() => handleChangeView('pinned')} />
                </Box>

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

                {/* "Your apps" rail: the user's own Reachy apps from
                    their HF account (private included). Rendered as
                    the FIRST swiper, just above the category rails.
                    Hidden in search mode (like the category rails)
                    and omitted entirely when the user has no such
                    apps / is signed out, so it never adds empty
                    chrome. No dedup with the catalog rails by
                    design. */}
                {!filtered.isSearching && myApps.apps.length > 0 && (
                  <LazyMount minHeight={RAIL_PLACEHOLDER_HEIGHT}>
                    <Box sx={RAIL_PANEL_FIRST_SX}>
                      <AppRail
                        label="Your apps"
                        subLabel={
                          myApps.apps[0]?.author
                            ? `@${myApps.apps[0].author} - ${myApps.apps.length} app${myApps.apps.length === 1 ? '' : 's'}`
                            : `${myApps.apps.length} app${myApps.apps.length === 1 ? '' : 's'}`
                        }
                      >
                        {myApps.apps.map(app => (
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
                  </LazyMount>
                )}

                {/* Browse rails. Hidden during search mode (the
                    search results take over the body). The bucket
                    size is rendered next to the label so the user
                    knows how many apps live in each rail at a
                    glance. Sparse buckets (< MIN_RAIL_SIZE) were
                    already filtered out by `useFilteredApps`. */}
                {!filtered.isSearching &&
                  filtered.rails.map((bucket, idx) => (
                    <LazyMount key={bucket.descriptor.id} minHeight={RAIL_PLACEHOLDER_HEIGHT}>
                      <Box
                        sx={
                          idx === 0 && myApps.apps.length === 0
                            ? RAIL_PANEL_FIRST_SX
                            : RAIL_PANEL_SX
                        }
                      >
                        <AppRail
                          label={bucket.descriptor.label}
                          count={bucket.apps.length}
                          onSeeAll={() => setFocusedCategoryId(bucket.descriptor.id)}
                        >
                          {bucket.apps.slice(0, RAIL_PREVIEW_CAP).map(app => (
                            <AppCompactTile
                              key={app.id}
                              app={app}
                              isPinned={pinnedApps.set.has(app.id)}
                              onOpen={onOpen}
                              onTogglePin={handleTogglePin}
                            />
                          ))}
                          {/* CTA tile pinned to the right of every
                              rail: same width branch as the app
                              tiles so the "1 + 30 % peek" framing
                              stays consistent, dashed primary
                              border to signal it's an affordance
                              rather than another app. */}
                          <AppCreateYourOwnTile />
                        </AppRail>
                      </Box>
                    </LazyMount>
                  ))}

                {/* End-of-list "Want to create your own?" footer.
                    Mounted only in browse mode (no search query,
                    no focused category) so it acts as a soft
                    landing after the last rail, mirroring the
                    desktop app's discover-Footer + CreateAppTutorial
                    pattern. The rails-only check keeps it hidden
                    when the catalog is empty or the user has hidden
                    the only contributing authors (no rails → no
                    footer either, the empty-state placeholder
                    already covers that case).
                    ────────────────
                    The footer is a self-contained tinted card
                    (own gradient bg + rounded border), so we
                    skip `PANEL_SX` here and just re-constrain
                    to the centred column with a top spacer big
                    enough to detach it visually from the last
                    rail. */}
                {!filtered.isSearching && filtered.rails.length > 0 && (
                  <Box sx={{ ...COLUMN_SX, pt: 5, pb: 1 }}>
                    <AppsCreateFooter />
                  </Box>
                )}
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
                apps surface via search). These lists can run to the
                full catalog (200-300 rows), so they are windowed via
                `VirtualAppList`: only the visible rows (+ overscan)
                are ever mounted, virtualised against the tab's shared
                scroll body. */}
            {showFlatList && (
              <VirtualAppList
                apps={flatList}
                scrollRef={scrollRef}
                pinnedSet={pinnedApps.set}
                onOpen={onOpen}
                onTogglePin={handleTogglePin}
              />
            )}
          </>
        ))}
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
 * Store header: the store's top block, in two tiers.
 *
 *   1. Title row - a back IconButton sits inline to the left of the
 *      "Discover apps" title (so "return to launcher" costs zero extra
 *      vertical space - no standalone chevron row). The title is sized
 *      to match the Settings sheet header (`TYPO.xxl` / bold) so the
 *      two top-level surfaces read at the same hierarchy.
 *   2. Hero row - a short blurb + the "tap ★ to add to your launcher"
 *      hint on the left, the rotating `<ReachiesCarousel>` (a Reachy
 *      persona cross-fading every ~0.75 s, the touch the old
 *      illustration-heavy `IntroPanel` carried) on the right.
 *
 * Layout:
 *
 *   [‹]  Discover apps
 *   Browse community-made apps for your Reachy.   ┌────┐
 *   Tap the ★ on any app to add it to your ...    │ 🤖 │
 *                                                 └────┘
 */
function StoreHeader({ onBack }: { onBack: () => void }) {
  return (
    <Box sx={COLUMN_SX}>
      {/* Single row so the rotating Reachy persona can take the FULL
          header height (title row + blurb) and visually overflow up to
          the "Discover apps" title, rather than being boxed into a small
          square next to the blurb only. Left column stacks the title +
          blurb; the carousel on the right `stretch`es to that column's
          height. */}
      <Stack direction="row" spacing={2} sx={{ alignItems: 'stretch' }}>
        <Stack sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <IconButton
              size="small"
              aria-label="Back to launcher"
              onClick={onBack}
              sx={{ ml: -0.5, flexShrink: 0 }}
            >
              <ArrowBackIosNewIcon sx={{ fontSize: TYPO.md }} />
            </IconButton>
            <Typography
              component="h2"
              sx={{
                fontSize: TYPO.xxl,
                fontWeight: FONT_WEIGHT.bold,
                color: 'text.primary',
                letterSpacing: '-0.3px',
                lineHeight: 1.2,
              }}
            >
              Discover apps
            </Typography>
          </Stack>

          <Stack spacing={0.5} sx={{ mt: 1.5, flex: 1, justifyContent: 'center' }}>
            <Typography
              sx={{
                fontSize: TYPO.body,
                fontWeight: FONT_WEIGHT.medium,
                color: 'text.primary',
                lineHeight: 1.4,
              }}
            >
              Browse community-made apps for your Reachy.
            </Typography>
            <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary', lineHeight: 1.4 }}>
              Tap the{' '}
              <Box component="span" sx={{ display: 'inline-flex', verticalAlign: '-4px' }}>
                <StarOutlineIcon sx={{ fontSize: 18 }} />
              </Box>{' '}
              on any app to add it to your launcher.
            </Typography>
          </Stack>
        </Stack>

        {/* Carousel fills the full header height. `overflow: hidden`
            clips the carousel's `zoom > 1` spill to the slot. */}
        <Box
          aria-hidden
          sx={{
            flexShrink: 0,
            alignSelf: 'stretch',
            width: 'calc((100% - 48px) / 3.2)',
            overflow: 'hidden',
          }}
        >
          <ReachiesCarousel zoom={1.1} verticalAlign="55%" />
        </Box>
      </Stack>
    </Box>
  );
}

/**
 * Launcher view: the "Pinned" sub-view. A 2-column grid of big
 * `AppLauncherCard`s (icon + name + description, whole card opens the
 * app) presenting the user's curated set - seeded with the official
 * Pollen apps - as a home screen. Reuses the same "LABEL · N" header +
 * Edit/Done toggle rhythm as the store's `PinnedGrid`. Empty until the
 * user pins something, where it points them to the store.
 */
function LauncherView({
  apps,
  recentlyAddedId,
  onOpen,
  onUnpin,
  onReorder,
  onBrowseStore,
}: {
  apps: AppEntry[];
  recentlyAddedId: string | null;
  onOpen: (app: AppEntry) => void;
  onUnpin: (app: AppEntry) => void;
  onReorder: (orderedIds: string[]) => void;
  onBrowseStore: () => void;
}) {
  const [editMode, setEditMode] = useState(false);

  // Drag-to-reorder sensors (edit mode only). A small distance / delay
  // activation keeps taps (open app) and the unpin badge clickable: a
  // press only becomes a drag once the pointer travels past the
  // threshold. Keyboard sensor gives the grid arrow-key reordering for
  // free (a11y).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = apps.findIndex(a => a.id === active.id);
      const newIndex = apps.findIndex(a => a.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      onReorder(arrayMove(apps, oldIndex, newIndex).map(a => a.id));
    },
    [apps, onReorder],
  );

  // Auto-exit edit mode once the launcher empties out (the last unpin
  // would otherwise leave a dangling "Done" over an empty grid).
  useEffect(() => {
    if (apps.length === 0 && editMode) setEditMode(false);
  }, [apps.length, editMode]);

  if (apps.length === 0) {
    return <LauncherEmpty onBrowseStore={onBrowseStore} />;
  }

  return (
    <Box sx={{ ...COLUMN_SX, pt: 3.5 }}>
      <Stack
        direction="row"
        sx={{
          alignItems: 'center',
          justifyContent: 'space-between',
          mb: 3,
        }}
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
          {/* Same 4-square glyph as the bottom-nav "Apps" tab, so the
              launcher title visually ties back to its tab. */}
          <AppsIcon sx={{ fontSize: 24, color: 'text.primary', flexShrink: 0 }} />
          <Typography
            component="h2"
            sx={{
              fontSize: TYPO.xxl,
              fontWeight: FONT_WEIGHT.bold,
              color: 'text.primary',
              letterSpacing: '-0.3px',
              lineHeight: 1.2,
            }}
          >
            Your launcher
            <Box
              component="span"
              sx={{
                color: 'text.disabled',
                fontWeight: FONT_WEIGHT.regular,
                fontSize: TYPO.lg,
                ml: 0.75,
              }}
            >
              · {apps.length}
            </Box>
          </Typography>
        </Stack>
        <Button
          variant="outlined"
          color="primary"
          size="small"
          onClick={() => setEditMode(prev => !prev)}
          aria-pressed={editMode}
          aria-label={editMode ? 'Done editing launcher' : 'Edit launcher'}
          startIcon={
            editMode ? (
              <CheckRoundedIcon sx={{ fontSize: 16 }} />
            ) : (
              <EditOutlinedIcon sx={{ fontSize: 16 }} />
            )
          }
          sx={{ ...railActionButtonSx, '& .MuiButton-startIcon': { ml: -0.25, mr: 0.5 } }}
        >
          {editMode ? 'Done' : 'Edit'}
        </Button>
      </Stack>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          columnGap: 2,
          rowGap: 2,
        }}
      >
        {editMode ? (
          // Edit mode: the grid becomes a sortable surface. Each tile is
          // a drag handle (whole card) that reorders the pinned set;
          // dropping persists the new order via `onReorder`. The store
          // tile is omitted here - editing is about curating the
          // existing set, not browsing.
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={apps.map(a => a.id)} strategy={rectSortingStrategy}>
              {apps.map(app => (
                <SortableLauncherCard
                  key={app.id}
                  app={app}
                  recentlyAddedId={recentlyAddedId}
                  onOpen={onOpen}
                  onUnpin={onUnpin}
                />
              ))}
            </SortableContext>
          </DndContext>
        ) : (
          <>
            {apps.map(app => (
              <AppLauncherCard
                key={app.id}
                app={app}
                isNew={recentlyAddedId === app.id}
                editMode={false}
                onOpen={onOpen}
                onUnpin={onUnpin}
              />
            ))}
            {/* Store entry as the last grid cell: a dashed tile that
                reads as "add more / there's a catalog", sitting inline
                with the apps rather than displacing them. */}
            <StoreGridTile onClick={onBrowseStore} />
          </>
        )}
      </Box>
    </Box>
  );
}

/**
 * Sortable wrapper for a launcher card (edit mode only). dnd-kit's
 * sort transform/transition live on THIS wrapper (translate as
 * neighbours shuffle), while the inner `AppLauncherCard` keeps its own
 * edit-mode wiggle (a CSS rotate on a separate element, so the two
 * transforms compose cleanly). The whole tile is the drag handle.
 */
function SortableLauncherCard({
  app,
  recentlyAddedId,
  onOpen,
  onUnpin,
}: {
  app: AppEntry;
  recentlyAddedId: string | null;
  onOpen: (app: AppEntry) => void;
  onUnpin: (app: AppEntry) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: app.id,
  });
  return (
    <Box
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      sx={{
        // Required so touch drags don't get hijacked by the scroll
        // container; only applied to tiles while editing.
        touchAction: 'none',
        cursor: isDragging ? 'grabbing' : 'grab',
        position: 'relative',
        zIndex: isDragging ? 5 : 1,
        opacity: isDragging ? 0.9 : 1,
        outline: 'none',
        '&:focus-visible': { outline: 'none' },
      }}
    >
      <AppLauncherCard
        app={app}
        isNew={recentlyAddedId === app.id}
        editMode
        onOpen={onOpen}
        onUnpin={onUnpin}
      />
    </Box>
  );
}

/** Empty launcher: a friendly nudge toward the store. Built on the
 *  shared `IllustratedState` so its sizing matches the app's other
 *  full-screen states. */
function LauncherEmpty({ onBrowseStore }: { onBrowseStore: () => void }) {
  return (
    <Box
      sx={{
        ...COLUMN_SX,
        pt: 5,
        display: 'flex',
        justifyContent: 'center',
      }}
    >
      <IllustratedState
        illustration={<ReachiesCarousel zoom={1.5} verticalAlign="42%" />}
        title="Your launcher is empty"
        description="Pin apps from the store and they'll show up here for one-tap access."
      >
        <StoreCta onClick={onBrowseStore} />
      </IllustratedState>
    </Box>
  );
}

/**
 * Store grid tile: the store entry for a NON-empty launcher. Rendered
 * as the last cell of the 2-up launcher grid so it sits inline with the
 * user's apps (never pushing them down). Dashed outline + storefront
 * glyph read as "there's a catalog to browse / add more", echoing an
 * empty-slot affordance while matching `AppLauncherCard`'s footprint.
 */
function StoreGridTile({ onClick }: { onClick: () => void }) {
  return (
    <ButtonBase
      onClick={onClick}
      aria-label="Browse the store"
      sx={theme => ({
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        height: '100%',
        minHeight: 172,
        boxSizing: 'border-box',
        p: 2,
        borderRadius: `${RADIUS.lg}px`,
        border: `1.5px dashed ${alpha(theme.palette.primary.main, 0.5)}`,
        bgcolor: alpha(theme.palette.primary.main, 0.04),
        WebkitTapHighlightColor: 'transparent',
        transition: 'background-color 0.15s ease, border-color 0.15s ease, transform 0.1s ease',
        '&:hover': {
          bgcolor: alpha(theme.palette.primary.main, 0.08),
          borderColor: alpha(theme.palette.primary.main, 0.8),
        },
        '&:focus-visible': {
          outline: `2px solid ${theme.palette.primary.main}`,
          outlineOffset: 2,
        },
        '&:active': { transform: 'scale(0.97)' },
      })}
    >
      <Box
        sx={theme => ({
          width: 56,
          height: 56,
          borderRadius: `${RADIUS.md}px`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: alpha(theme.palette.primary.main, 0.12),
          color: 'primary.main',
        })}
      >
        <StorefrontOutlinedIcon sx={{ fontSize: 30 }} />
      </Box>
      <Typography
        sx={{ mt: 1.25, fontSize: TYPO.md, fontWeight: FONT_WEIGHT.bold, color: 'text.primary', lineHeight: 1.25 }}
      >
        Browse the store
      </Typography>
      <Typography sx={{ mt: 0.5, fontSize: TYPO.xs, color: 'text.secondary', lineHeight: 1.4 }}>
        Discover more apps
      </Typography>
    </ButtonBase>
  );
}

/**
 * Store call-to-action: a big, friendly button used as the empty
 * launcher's hero (nothing else competes there). Signals "there's a
 * whole catalog beyond your pinned apps" and opens the store.
 */
function StoreCta({ onClick }: { onClick: () => void }) {
  return (
    <ButtonBase
      onClick={onClick}
      aria-label="Browse the store"
      sx={theme => ({
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 1.75,
        px: 2.25,
        py: 2,
        borderRadius: `${RADIUS.lg}px`,
        textAlign: 'left',
        // Dashed outline reads as "open container / there's more to add"
        // rather than a solid committed surface like an app card.
        border: `1.5px dashed ${alpha(theme.palette.primary.main, 0.55)}`,
        bgcolor: alpha(theme.palette.primary.main, 0.05),
        transition: 'background-color 0.15s ease, border-color 0.15s ease, transform 0.1s ease',
        WebkitTapHighlightColor: 'transparent',
        '&:hover': {
          bgcolor: alpha(theme.palette.primary.main, 0.09),
          borderColor: alpha(theme.palette.primary.main, 0.8),
        },
        '&:active': { transform: 'scale(0.99)' },
      })}
    >
      <Box
        sx={theme => ({
          width: 46,
          height: 46,
          flexShrink: 0,
          borderRadius: `${RADIUS.md}px`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: alpha(theme.palette.primary.main, 0.14),
          color: 'primary.main',
        })}
      >
        <StorefrontOutlinedIcon sx={{ fontSize: 26 }} />
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          sx={{ fontSize: TYPO.md, fontWeight: FONT_WEIGHT.bold, color: 'text.primary', lineHeight: 1.25 }}
        >
          Browse the store
        </Typography>
        <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary' }}>
          Discover more apps for your Reachy
        </Typography>
      </Box>
      <ChevronRightRoundedIcon sx={{ color: 'primary.main', flexShrink: 0 }} />
    </ButtonBase>
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
      onChange={e => onChange(e.target.value)}
      placeholder={`Search ${total} app${total === 1 ? '' : 's'}, authors...`}
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      slotProps={{
        input: {
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
            '& input': {
              py: 1.75,
            },
          },
        },
      }}
    />
  );
}

/**
 * Full-height centering wrapper for the tab's initial states
 * (loading spinner, error, empty). Fills the scroll body's
 * height (`minHeight: 100%` resolves against the flex:1 scroll
 * container) and centers its child both axes, so the spinner
 * reads as a proper "loading the whole view" screen rather than
 * a small hint pinned to the top.
 */
function FullHeightCenter({ children }: { children: React.ReactNode }) {
  return (
    <Box
      sx={{
        minHeight: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        ...COLUMN_SX,
        py: 6,
      }}
    >
      {children}
    </Box>
  );
}

function CenteredHint({ children }: { children: React.ReactNode }) {
  return (
    <Stack
      spacing={1}
      sx={{
        alignItems: 'center',
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
