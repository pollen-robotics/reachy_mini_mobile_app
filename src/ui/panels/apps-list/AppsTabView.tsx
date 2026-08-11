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
 *               drill-down focus list). Its three rendering modes are
 *               described below. Both store "pages" (browse and the
 *               category drill-down) are topped by the same
 *               `CollapsingHeaderBar`: a permanently-sticky, iOS
 *               large-title-style bar carrying the back chevron +
 *               title, which shrinks as the user scrolls. The back
 *               affordance is therefore reachable at ANY scroll
 *               depth - no more scrolling back to the top to leave.
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
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react';
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
import StoreIntroOverlay from './StoreIntroOverlay';
import VirtualAppList from './VirtualAppList';
import { COLUMN_SX } from './layout';

/** Imperative surface the host shell can drive. */
export interface AppsTabViewHandle {
  /** Pop the tab back to its root "Your apps" launcher view (used by
   *  the bottom nav's "re-tap the active Apps tab" gesture). */
  popToRoot: () => void;
}

interface AppsTabViewProps {
  onOpen: (app: AppEntry) => void;
  ref?: Ref<AppsTabViewHandle>;
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
 * Geometry of the store's `CollapsingHeaderBar`.
 *
 * The bar keeps a CONSTANT height (fixed paddings, no animated
 * dimension) - only the title's `transform: scale()` animates, which
 * never reflows. The title shrinks from `TYPO.xxl` down to
 * `TITLE_COLLAPSED_SCALE` of its size over the first
 * `COLLAPSE_RANGE_PX` of scroll.
 */
const COLLAPSE_RANGE_PX = 48;
const TITLE_COLLAPSED_SCALE = 0.8;

/**
 * localStorage key (same `reachy.` namespace as the pin / hidden-
 * authors stores) remembering that the user saw the first-visit
 * store intro (`StoreIntroOverlay`). Written on the "Got it" tap,
 * PROD ONLY - dev builds neither read nor write it (see the
 * `introSeen` state below).
 */
const STORE_INTRO_SEEN_KEY = 'reachy.apps.storeIntroSeen';

/**
 * Visual rhythm: the store body is deliberately divider-less at rest -
 * the search panel and the category rails self-delimit via spacing and
 * their `LABEL · count` headers. The ONLY hairline is the sticky
 * header bar's, and it fades in with scroll (see
 * `CollapsingHeaderBar`), so the unscrolled page reads as one plain
 * sheet.
 */
const RAIL_PANEL_SX = {
  pt: 4,
  pb: 0,
} as const;

// First rail sits right under the search panel, so it needs far less
// top margin than the inter-rail gap above.
const RAIL_PANEL_FIRST_SX = {
  pt: 2.5,
  pb: 0,
} as const;

export default function AppsTabView({ onOpen, ref }: AppsTabViewProps) {
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

  // Host hook: re-tapping the active Apps tab in the bottom nav pops
  // the sub-navigation back to the launcher (the standard mobile
  // "tap the tab you're on = back to its root" gesture).
  useImperativeHandle(
    ref,
    () => ({ popToRoot: () => handleChangeView('pinned') }),
    [handleChangeView]
  );

  // Push/pop scroll reset. The launcher, the store browse layout and
  // the category drill-down all share ONE scroll container, so without
  // this a drill-down would inherit the browse scroll offset (and the
  // way back too). Resetting on every sub-page transition makes each
  // "page" land at its top, matching the push/pop mental model the
  // sticky header bar sells. Also re-zeroes the bar's collapse state
  // via the scroll event this emits.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [view, focusedCategoryId]);

  // Store intro overlay (see `StoreIntroOverlay`).
  //
  // PROD: one-shot onboarding. The seen-flag is persisted to
  // localStorage on the "Got it" tap (on DISMISSAL, not on show, so a
  // user who kills the app mid-intro is greeted again next launch)
  // and the intro never resurfaces once dismissed.
  //
  // DEV: no persistence at all - the stored flag is neither read nor
  // written, and the seen-state re-arms every time the user leaves
  // the store sub-view, so the intro shows on EVERY store entrance
  // while iterating on it.
  const [introSeen, setIntroSeen] = useState<boolean>(() => {
    if (import.meta.env.DEV) return false;
    try {
      return window.localStorage.getItem(STORE_INTRO_SEEN_KEY) === '1';
    } catch {
      return false;
    }
  });
  const dismissIntro = useCallback(() => {
    setIntroSeen(true);
    if (import.meta.env.DEV) return;
    try {
      window.localStorage.setItem(STORE_INTRO_SEEN_KEY, '1');
    } catch {
      // Private mode / quota: the intro still hides for this session.
    }
  }, []);
  useEffect(() => {
    if (import.meta.env.DEV && view !== 'store') setIntroSeen(false);
  }, [view]);

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
        // Anchor for the absolutely-positioned first-visit store
        // intro overlay, which covers exactly this tab body.
        position: 'relative',
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
            {/* Focused-category header: the same sticky collapsing
                bar as the browse layout's "Discover apps" - one line,
                back chevron + label + inline count, same typography,
                same placement, same collapse-on-scroll. The two store
                pages read as siblings and the back affordance never
                scrolls away. */}
            {focusedBucket && (
              <CollapsingHeaderBar
                scrollRef={scrollRef}
                title={focusedBucket.descriptor.label}
                count={focusedBucket.apps.length}
                backLabel="Back to apps"
                onBack={() => setFocusedCategoryId(null)}
              />
            )}

            {/* Browse panels: pinned + search + per-category rails.
                Each lives in its own bottom-divider panel. */}
            {!focusedBucket && (
              <>
                {/* Store header bar: permanently-sticky back chevron +
                    "Discover apps" title, shrinking as the user
                    scrolls (iOS large-title pattern). No hero below:
                    onboarding lives in the one-shot `StoreIntroOverlay`
                    sheet, so browse starts straight at the search
                    panel. */}
                <CollapsingHeaderBar
                  scrollRef={scrollRef}
                  title="Discover apps"
                  backLabel="Back to launcher"
                  onBack={() => handleChangeView('pinned')}
                />

                {/* Search panel: regular scrolling content (it used
                    to be sticky under the header bar, but the pinned
                    bar + search combo ate ~120px of a phone screen;
                    the header bar alone keeps the way back always
                    reachable, and search is a "top of the store"
                    action anyway). No divider: at rest the store top
                    must read as one plain sheet - the only hairline
                    is the header bar's, which fades in with scroll.
                    Tight vertical padding: with the dividers gone the
                    search no longer needs panel-sized breathing room. */}
                <Box
                  sx={{
                    py: 1.5,
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

      {/* First-visit store onboarding overlay: an opaque cover of
          this tab body (absolute against the relative Stack above).
          Gated on the persisted seen-flag AND on real store content
          being visible (never over the loading / error
          placeholders). */}
      {view === 'store' && !introSeen && initialPlaceholder === null && (
        <StoreIntroOverlay onDismiss={dismissIntro} />
      )}
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
 * Collapsing sticky header bar, shared by the store's two "pages"
 * (browse's "Discover apps" and the focused-category drill-down) so
 * both read at the same hierarchy with the same back affordance.
 *
 * iOS large-title flavour: the bar is permanently stuck to the top of
 * the scroll body (the back chevron stays reachable at ANY scroll
 * depth - the whole point), and the title shrinks from `TYPO.xxl`
 * toward `TITLE_COLLAPSED_SCALE` over the first `COLLAPSE_RANGE_PX`
 * of scroll. A permanent bottom hairline detaches the bar from the
 * content sliding underneath.
 *
 * The collapse progress is scroll-linked but deliberately bypasses
 * React state: a passive rAF-throttled scroll listener writes a
 * `--collapse` custom property onto the SCROLL CONTAINER itself
 * (inherited by the bar and any sibling panel that wants to react to
 * the collapse), and styles consume it via `calc()`. Re-rendering
 * the whole Apps tree at scroll frequency just to shrink a title
 * would jank the rails; this way React renders the bar exactly once.
 *
 * The title shrinks via `transform: scale()` (composited, no reflow)
 * with a left origin so it contracts toward the chevron, and the bar
 * keeps a CONSTANT height (fixed paddings, nothing dimensional
 * animates) so the content below never shifts as the collapse runs.
 *
 * Layout (collapse 0 → 1):
 *
 *   [‹]  Discover apps        →     [‹] Discover apps
 *   [‹]  Most liked · 12      →     [‹] Most liked · 12
 */
function CollapsingHeaderBar({
  scrollRef,
  title,
  count,
  backLabel,
  onBack,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  title: string;
  count?: number;
  backLabel: string;
  onBack: () => void;
}) {
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const progress = Math.min(1, Math.max(0, scroller.scrollTop / COLLAPSE_RANGE_PX));
      scroller.style.setProperty('--collapse', progress.toFixed(3));
    };
    const onScroll = () => {
      if (raf === 0) raf = requestAnimationFrame(update);
    };
    update();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (raf !== 0) cancelAnimationFrame(raf);
      scroller.style.removeProperty('--collapse');
    };
  }, [scrollRef]);

  return (
    <Box
      sx={{
        position: 'sticky',
        top: 0,
        // Above the scroll body's regular content so the bar's opaque
        // bg hides whatever slides underneath while pinned.
        zIndex: 3,
        bgcolor: 'background.default',
        // Scroll-linked hairline: invisible at rest (the unscrolled
        // page reads as one plain sheet, no chrome), fading in with
        // the collapse so the pinned bar detaches from the content
        // sliding underneath. Pseudo-element instead of a real border
        // so the bar's height never changes and opacity can ride the
        // same `--collapse` variable as the title scale.
        '&::after': {
          content: '""',
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: '1px',
          bgcolor: 'divider',
          opacity: 'var(--collapse, 0)',
        },
      }}
    >
      {/* Clones the launcher header's measured geometry (title at
          x=56 / y=30 in a 390px viewport with the 24px gutter) so
          switching launcher <-> store never makes the title row
          jump. Plain flex Box on purpose: MUI's `Stack spacing`
          emits a `& > :not(style):not(style) { margin: 0 }` reset
          that OVERRIDES any sx margin on the children - the very
          negative margins this row depends on. */}
      <Box
        sx={{
          ...COLUMN_SX,
          display: 'flex',
          alignItems: 'center',
          // At rest the paddings clone the launcher header (30px
          // above the title so it lands at the launcher's y, 24px of
          // air below = the launcher's `mb: 3`); once pinned BOTH
          // converge to 22px so the title row sits dead-centre in
          // the fixed chrome. Scroll-linked through the same
          // `--collapse` variable as the title scale, so everything
          // eases together (bar: 78px at rest → 68px pinned).
          pt: 'calc(30px - 8px * var(--collapse, 0))',
          pb: 'calc(24px - 2px * var(--collapse, 0))',
        }}
      >
        {/* Margin math (all vs the 24px column gutter):
            - `ml: -1.625` = -8px button padding -5px of internal SVG
              whitespace (the ArrowBackIosNew stroke starts at 1/4 of
              its viewBox, so 5px at a 20px glyph), so the VISIBLE
              stroke sits on the gutter exactly like the launcher's
              AppsIcon edge.
            - `mr: 1.125` lands the title at gutter+32px = the
              launcher's title x (24px glyph + 8px gap).
            - `my: -1` collapses the 36px hitbox to the text row's
              height so the tall button never inflates the bar. */}
        <IconButton
          aria-label={backLabel}
          onClick={onBack}
          sx={{ p: 1, ml: -1.625, mr: 1.125, my: -1, flexShrink: 0, color: 'primary.main' }}
        >
          <ArrowBackIosNewIcon sx={{ fontSize: 20 }} />
        </IconButton>
        <Typography
          component="h2"
          sx={{
            fontSize: TYPO.xxl,
            fontWeight: FONT_WEIGHT.bold,
            color: 'text.primary',
            letterSpacing: '-0.3px',
            lineHeight: 1.2,
            minWidth: 0,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            transform: `scale(calc(1 - ${1 - TITLE_COLLAPSED_SCALE} * var(--collapse, 0)))`,
            transformOrigin: 'left center',
            willChange: 'transform',
          }}
        >
          {title}
          {/* Inline count, launcher-title style ("Most liked · 12"):
              one line with the label, never a second sub-line. */}
          {count !== undefined && (
            <Box
              component="span"
              sx={{
                color: 'text.disabled',
                fontWeight: FONT_WEIGHT.regular,
                fontSize: TYPO.lg,
                ml: 0.75,
              }}
            >
              · {count}
            </Box>
          )}
        </Typography>
      </Box>
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
 *  full-screen states, and on `FullHeightCenter` so it sits in the
 *  vertical middle of the tab body like the loading/error states. */
function LauncherEmpty({ onBrowseStore }: { onBrowseStore: () => void }) {
  return (
    <FullHeightCenter>
      <IllustratedState
        illustration={<ReachiesCarousel zoom={1.5} verticalAlign="42%" />}
        title="Your launcher is empty"
        description="Pin apps from the store and they'll show up here for one-tap access."
      >
        <StoreCta onClick={onBrowseStore} />
      </IllustratedState>
    </FullHeightCenter>
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
