# Apps tab redesign - design specification

Status: draft. Owner: `@tfrere`. Implementation lives in
`src/ui/panels/apps-list/`.

This document is the single source of truth for the upcoming redesign
of the **Apps tab** (currently `AppsTabView` + `AppCard`). It covers
the layout, interactions, theming/categorisation strategy, and the
search-driven mode switch.

It supersedes the freeform design exploration in chat. **Read this
before touching any of:**

- `src/ui/panels/apps-list/AppsTabView.tsx`
- `src/ui/panels/apps-list/AppCard.tsx`
- `src/features/apps/useApps.ts`
- `src/features/apps/types.ts`

---

## 1. Context

### 1.1 Today's surface

The Apps tab is a single virtualised vertical list of `AppCard`
items, ~228 px each, sorted by catalog order. There is **no**:

- pin / favourite mechanism,
- search input,
- thematic grouping,
- sort or filter control.

Every catalog entry that carries the `reachy_mini_js_app` tag is
rendered identically, in catalog order, end-to-end.

### 1.2 Catalog scale (snapshot)

Endpoint: `GET https://pollen-robotics-reachy-mini.hf.space/api/apps`,
filtered client-side on the `reachy_mini_js_app` tag (see
`features/apps/useApps.ts`).

> **Endpoint migration: shipped (2026-05).** The mobile app now
> consumes `GET /api/js-apps`, which pre-filters JS apps server-side
> and attaches an LLM-classified `categories` field per entry (see
> Section 5 for the contract). The old client-side
> `reachy_mini_js_app` filter is gone (see `features/apps/useApps.ts`).
> The legacy `/api/apps` references in §1.1 and the migration table
> below are kept as historical context for the pre-migration baseline.

| Metric | Value |
|---|---|
| Total catalog entries | 224 |
| JS apps (after `reachy_mini_js_app` filter) | 21 |
| Distinct authors | 12 |
| Apps from `pollen-robotics` (officials) | 0 |
| Apps with at least one usable category tag | 0 |
| Top likes | 22 |

**Key finding**: every JS app carries the same handful of tags
(`reachy_mini`, `reachy_mini_js_app`, `region:us`, plus `static` or
`docker`). None of them is a domain category. **The catalog has no
"theme" data today**. Any thematic grouping must be sourced
elsewhere (see Section 5).

### 1.3 Why redesign now

- The catalog is small but already feels flat. Discovery is purely
  positional ("scroll until you recognise the emoji").
- Quick-access patterns are missing: a user who comes back to the
  same app every session has to scroll-and-recognise every time.
- The catalog will grow. We want a layout that scales from 20 to
  200 apps without re-architecting.

---

## 2. Goals

1. **Quick access to favourites**: pinned apps must be visible
   without scrolling, in 1 tap from the tab.
2. **Compact discovery**: the home view fits as much as possible
   above the fold, with horizontal rails for thematic browsing.
3. **Search that takes over**: typing in the search box collapses
   discovery into a single flat result list, no chrome, no rails.
4. **Scale-tolerant**: the same layout still reads well at 20, 50,
   100, 200 apps.
5. **No regression on launch flow**: tapping an app still releases
   the WebRTC session and mounts the iframe overlay through
   `RobotSessionScreen.setOpenedApp`.

## 3. Non-goals (V1)

- Editorial hero / "Today" stories. The catalog is too small and
  there is no curation pipeline.
- Multi-page navigation (e.g. a separate `Library` route). The
  whole experience lives inside the single Apps tab.
- Server-side search. Filtering happens entirely client-side over
  the in-memory catalog.
- Personalised ranking ("most used by you"). Pin is the only
  user-driven signal we surface.
- Install / uninstall (mobile only iframes apps; the desktop path
  for installed catalogs stays out of scope).

---

## 4. Layout

The tab body is a single vertical scroll container. It has two
modes driven by the search input:

- **Browse mode** (search is empty): pinned + horizontal rails.
- **Search mode** (search has content): flat result list.

### 4.1 Browse mode

```
┌────────────────────────────────────────────────────┐
│  Apps · 21                                  ↻      │  sub-header
├────────────────────────────────────────────────────┤
│                                                    │
│  ⭐ PINNED                                  Edit ›  │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ →   │
│  │ 🎵   │ │ 🎮   │ │ 👀   │ │ 💃   │ │  +   │     │
│  │  DJ  │ │ Pong │ │ Eye  │ │Dance │ │ Add  │     │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘     │
│                                                    │
├────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────┐    │
│  │ 🔍  Search apps, authors...                │    │  sticky on scroll
│  └────────────────────────────────────────────┘    │
├────────────────────────────────────────────────────┤
│                                                    │
│  🎵  MUSIC & DANCE                          See ›  │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ →    │
│  │  🎵    │ │  🕺    │ │  🎶    │ │  🎤    │      │
│  │  DJ    │ │ Dance  │ │ Quiz   │ │Karaoke │      │
│  │ ❤ 248  │ │ ❤  22  │ │ ❤  14  │ │ ❤   3  │      │
│  └────────┘ └────────┘ └────────┘ └────────┘      │
│                                                    │
│  🗣  VOICE & STORIES                        See ›  │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ →    │
│  │  📚    │ │  🌙    │ │  🤖    │ │  🏄    │      │
│  │TellMe  │ │Stories │ │ Conv   │ │ Surf   │      │
│  │ ❤   1  │ │ ❤   6  │ │ ❤   3  │ │ ❤   1  │      │
│  └────────┘ └────────┘ └────────┘ └────────┘      │
│                                                    │
│  👁  VISION & CAMERA                        See ›  │
│  ┌────────┐ ┌────────┐ ┌────────┐                  │
│  │  🪞    │ │  👋    │ │  🎭    │                  │
│  │ Mime   │ │ Hand   │ │Mariont │                  │
│  │ ❤   3  │ │ ❤   0  │ │ ❤   2  │                  │
│  └────────┘ └────────┘ └────────┘                  │
│                                                    │
│  🛠  DEMOS & TOOLS                          See ›  │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ →    │
│  │  🤖    │ │  📞    │ │  📡    │ │  🗣    │      │
│  │WebRTC  │ │Remote  │ │ Morse  │ │ TTS    │      │
│  │ ❤   6  │ │ ❤   0  │ │ ❤   0  │ │ ❤   0  │      │
│  └────────┘ └────────┘ └────────┘ └────────┘      │
│                                                    │
├────────────────────────────────────────────────────┤
│                                                    │
│  ALL APPS                                          │
│  ┌──────────────────────────────────────────────┐  │
│  │ 🎵   Reachy DJ                          ★   │  │
│  │      pollen ✓     ❤ 248                     │  │
│  └──────────────────────────────────────────────┘  │
│  ... full list, sorted by likes ...                │
│                                                    │
└────────────────────────────────────────────────────┘
```

Notes:

- The **PINNED rail** is omitted entirely when the user has zero
  pins. We do not render an empty rail with a single `+` tile in
  V1: a first-run user lands on a tab with no pin chrome at all
  (less noise, fewer affordances to ignore).
- Each thematic rail is **omitted when the category has zero
  apps** in the current catalog. So today, only the four rails
  with content render. The "ALL APPS" trailing section guarantees
  every app is reachable even if our categorisation misclassifies.
- The horizontal tile is the **compact tile** (Section 4.3); the
  vertical row in "ALL APPS" is the **list row** (Section 4.4).

### 4.2 Search mode

Triggered as soon as `searchQuery.trim() !== ''`. Pinned rail and
all thematic rails collapse. The "ALL APPS" section becomes a
flat filtered list; the search input remains sticky.

```
┌────────────────────────────────────────────────────┐
│  Apps · 21                                  ↻      │
├────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────┐    │
│  │ 🔍  reachy d|                        ✕     │    │
│  └────────────────────────────────────────────┘    │
│  3 results                                         │
├────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────┐  │
│  │ 🎵   Reachy DJ                          ★   │  │
│  │      pollen ✓     ❤ 248                     │  │
│  └──────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────┐  │
│  │ 🕺   reachy-dance-duo                    ☆  │  │
│  │      TwinPeaksTownie  ❤  22                 │  │
│  └──────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────┐  │
│  │ 🎵   Reachy Beat - Music Dance           ☆  │  │
│  │      Bingbong25       ❤   1                 │  │
│  └──────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────┘
```

Empty result:

```
│  No apps match "xyz".                              │
│  Tip: try the author name, or clear the search.    │
```

The toggle is a **pure state derivative** (no animation, no
transition between the two modes for V1). Clearing the input
restores Browse mode.

### 4.3 Compact tile (used in horizontal rails)

Single fixed-size card, ~120 x 140 px, designed to fit 2.5 visible
on a 360 px viewport so the rail always advertises horizontal
scroll affordance.

```
┌────────────┐
│  🎵        │  emoji 28 px, top-left
│            │
│            │
│ Reachy DJ  │  name (1 line, ellipsis), 14 px semibold
│ pollen ✓   │  author + Official tick (1 line, mono, secondary)
│ ❤ 248      │  likes (1 line, secondary)
└────────────┘
```

Tap = open the app (same `setOpenedApp(app)` path as today).
Long-press = pin/unpin sheet.

### 4.4 List row (used in "ALL APPS" and search results)

Reuses the existing `AppCard` shape but condensed: the description
clamp drops from 2 lines to 1, the date row is removed, the
"Launch" button is removed (the whole row is tappable). The right
edge carries a star toggle (`★` filled if pinned, `☆` otherwise)
that takes over the space previously held by the likes count.

```
┌──────────────────────────────────────────────┐
│ 🎵   Reachy DJ                          ★    │
│      pollen ✓     ❤ 248                      │
└──────────────────────────────────────────────┘
```

Height target: ~72 px (vs ~228 px today). The full list is still
virtualised because we want headroom for the catalog to grow past
50 entries without paying for off-screen rows.

### 4.5 Pinned tile (top-of-page rail)

Smaller than the compact tile, emoji-first, 1 line of name. Tile
size matches the `+` tile so the rail never shifts when the user
adds or removes a pin.

```
┌──────┐
│  🎵  │   emoji 32 px, centred
│      │
│  DJ  │   short name (1 line, ellipsis), 12 px medium
└──────┘
```

The trailing `+` opens a "Pick from catalog" sheet. Long-press on
a pinned tile opens an "Unpin" confirmation.

---

## 5. Categorisation strategy

The thematic rails (Section 4.1) need a category per app. **The
canonical source of truth is the website server**
(`reachy-mini-website`), which ships in two incremental commits:

1. **Commit 1**: a new `GET /api/js-apps` route that returns
   JS-only apps with a `categories` field set to `null` everywhere
   (no inference yet). The mobile app already migrates to this
   endpoint and falls back to "no rails" rendering.
2. **Commit 2**: an LLM inference step on the server (fetches each
   app's HF Space `README.md`, prompts a model, validates the
   output against the taxonomy, caches to disk). The same route
   then returns `categories: ['music']` etc.

The mobile app **never infers categories on the client**. It
consumes whatever the server publishes, and degrades gracefully
when the field is absent.

### 5.1 API contract (`/api/js-apps`)

Verified live on `https://pollen-robotics-reachy-mini.hf.space/api/js-apps`.

```jsonc
{
  "apps": [
    {
      "id": "TwinPeaksTownie/reachy-dance-duo",
      "name": "reachy-dance-duo",
      "description": "Turn any song into a Reachy Dance Party",
      "url": "https://huggingface.co/spaces/TwinPeaksTownie/reachy-dance-duo",
      "source_kind": "hf_space",
      "isOfficial": false,
      "categories": ["dance"],                // see contract below
      "categories_source": "inferred",        // "inferred" today, may grow
      "categorized_at": "2026-05-10T11:20:34.123Z",
      "extra": {
        "id": "TwinPeaksTownie/reachy-dance-duo",
        "author": "TwinPeaksTownie",
        "likes": 22,
        "createdAt": "2026-02-03T22:43:59Z",
        "lastModified": "2026-05-07T02:02:20Z",
        "tags": ["static", "reachy_mini", "reachy_mini_js_app", "..."],
        "isPythonApp": false,
        "cardData": {
          "emoji": "🕺",
          "short_description": "...",
          "sdk": "static",
          "tags": ["..."]
        }
      }
    }
  ],
  "count": 21,
  "cached": true,
  "cacheAge": 42,
  "categorization": {
    "enabled": true,
    "total": 21,
    "classified": 21,
    "pending": 0,
    "inProgress": false,
    "dataset": "tfrere/reachy-mini-app-categories",
    "taxonomyVersion": 1
  }
}
```

Field semantics:

| Field | Type | Notes |
|---|---|---|
| `categories` | `string[] \| null` | Array of taxonomy ids (Section 5.2). Multi-valued. `null` or `[]` means "not classified yet". The client treats both identically: the app does not appear in any rail, but still surfaces in "ALL APPS" and in search. |
| `categories_source` | `"inferred"` \| future literals | `inferred` = LLM. The server may later add `"curated"` for hand-edited overrides; the client only branches on this if we want to surface a different visual treatment (e.g. a small dot when curated). V1 ignores it. |
| `categorized_at` | ISO 8601 string | Display-only, available for "Updated last week" hints. V1 ignores. |
| `categorization` | object | Top-level meta. The client may surface `categorization.inProgress` as a subtle "Classifying new apps..." chip on the catalog header, but V1 ignores it. |

The server **does not publish a `taxonomy` field** in the response.
The mobile app embeds the mapping `id -> (label, emoji, render order)`
locally (see Section 5.2). The server's contract is a *closed set
of ids* (`taxonomyVersion`); the display metadata for those ids
is owned by the mobile build.

### 5.2 Taxonomy contract

The taxonomy is a small, finite set of well-known ids agreed
between the website and the mobile app. V1 picks four:

| Id | Display | Emoji |
|---|---|---|
| `music` | Music & Dance | 🎵 |
| `voice` | Voice & Stories | 🗣 |
| `vision` | Vision & Camera | 👁 |
| `tools` | Demos & Tools | 🛠 |

Render order on mobile = order of the array. The mobile app
embeds an exact mirror of this table in
`src/features/apps/categoryTaxonomy.ts` so it can render rails
even when the server doesn't publish `taxonomy` in the payload.
The embedded mirror is a **safety net, not a fallback for missing
ids**: when an app's `categories` array contains an id the
client doesn't know about, that id is silently dropped (the app
still surfaces in "ALL APPS").

Adding or renaming a category requires a coordinated change:

1. Update `server/categories.js` (taxonomy + LLM prompt).
2. Update `src/features/apps/categoryTaxonomy.ts` (mirror).
3. Ship the mobile build.

Old mobile clients on the wild stay safe: unknown ids are
ignored, no crash.

### 5.3 Rollout phases (mobile-side behaviour)

The redesign ships before Commit 2 lands, so the mobile UI must
read the same way at every phase of the server rollout:

| Phase | Server state | Mobile rendering |
|---|---|---|
| **0. legacy** | `/api/apps` only, no `categories` field | Mobile keeps the today's flat list. Shipping the redesign is gated on Phase 1 being live. |
| **1. route stub** | `/api/js-apps` returns `categories: null` everywhere | Mobile renders pinned rail + search + a single "ALL APPS" list, sorted by likes. **No thematic rails yet** (every category bucket is empty). |
| **2. LLM live** | `/api/js-apps` returns real `categories` | Mobile renders pinned rail + search + thematic rails (one per non-empty taxonomy id) + "ALL APPS" trailing. |
| **3. partial** | Some apps classified, some still `null` | Same as Phase 2. Apps with `null` only show up in "ALL APPS" and in search. |

The phase is detected implicitly: the rail is rendered iff at
least one app in the catalog has the corresponding taxonomy id
in its `categories` array. **There is no client-side feature
flag** and no need to coordinate a mobile release with Commit 2.

### 5.4 Why no client-side inference

Tempting alternative: keep a curated `id -> category` table on
the client as a fallback during Phase 1. We deliberately don't:

- It means two sources of truth (server + client). When the LLM
  inference disagrees with the curated table, the conflict is
  invisible.
- The curated table rots: every new app needs a mobile build to
  appear in a rail.
- Phase 1 is short (Commit 2 is the very next commit). Showing
  "ALL APPS" without thematic rails for a few days is acceptable.

The taxonomy mirror in `categoryTaxonomy.ts` is **not** a
classification source; it only carries display metadata
(label + emoji + order).

---

## 6. Behaviour contract

### 6.1 Search input

- Mounted between the pinned rail and the rails list. Sticky on
  scroll within the tab body (uses the same scroll container as
  the existing slide-up sub-header pattern, but does not slide).
- Debounce: 50 ms before re-running the filter. Catalog is small,
  filtering is in-memory, no need to be more careful.
- Filter predicate: case-insensitive `includes` on
  `name + author + description`. Tags are not matched (we have
  none of value today; revisit when Track A lands).
- Clear (`✕`) restores Browse mode immediately.
- Hardware back button on Android: if search is non-empty, first
  back press clears the search (no navigation). Second press
  exits the tab (existing behaviour).

### 6.2 Pin toggle

- Persisted in `localStorage` under `reachy.apps.pinnedIds`
  (string array of `AppEntry.id`). No server roundtrip in V1.
- Pin state survives reload, clears on logout (the auth feature
  already wipes per-user storage at sign-out).
- Pinning an app does **not** scroll-anchor; the rail just
  re-renders with the new tile.
- Cap at 12 pins (3 rows of 4 on a 360 px viewport). The 13th
  pin attempt prompts to unpin first. We can lift the cap once
  we observe how many users hit it.
- Pinning an app in "ALL APPS" or in a rail tile fires the same
  toast: "Pinned to top".

### 6.3 Tap to open

Unchanged from today: `onOpen(app)` flows through
`RobotSessionScreen.setOpenedApp(app)` which triggers the
`releaseForHandoff` -> iframe mount -> `reacquire` lifecycle.

The whole compact tile / list row is the tap surface. The star
icon in the list row stops propagation so toggling the pin
doesn't open the app.

### 6.4 "See ›" affordance per rail

Tapping the right-side `See ›` in a rail header swaps the rail's
horizontal track for a vertical full-list of just that category,
inline within the tab body. There is **no separate route**. The
header label gains a back chevron (`‹ Music & Dance`); tapping
again returns to Browse mode.

This keeps the redesign single-page (Section 3) while still
giving a focus mode for users who land on a rail they care about.

---

## 7. State machine

```
┌──────────┐  user types       ┌──────────┐
│  browse  │ ────────────────> │  search  │
│   mode   │                   │   mode   │
│          │ <──── clears ───  │          │
└──────────┘                   └──────────┘
     │                               │
     │ tap "See ›" on rail           │
     ▼                               │
┌──────────────┐                     │
│ category     │                     │
│ focus mode   │ ── tap back ────────┤
└──────────────┘                     │
                                     │ tap any tile / row
                                     ▼
                              ┌───────────────┐
                              │ iframe overlay │
                              │ (existing)     │
                              └───────────────┘
```

Three states + the existing iframe overlay. No animation between
states in V1.

---

## 8. Components touched

| File | Change |
|---|---|
| `src/ui/panels/apps-list/AppsTabView.tsx` | rewritten: orchestrates Browse vs Search vs Category-focus modes, renders rails and lists, owns the search state |
| `src/ui/panels/apps-list/AppCard.tsx` | renamed to `AppListRow.tsx`, condensed to ~72 px, drops description-line-2 + date + Launch button, gains star toggle |
| `src/ui/panels/apps-list/AppCompactTile.tsx` | new: compact horizontal-rail tile (~120 x 140 px) |
| `src/ui/panels/apps-list/AppPinnedTile.tsx` | new: pinned-rail tile (~64 x 64 px square) |
| `src/ui/panels/apps-list/AppRail.tsx` | new: horizontal scroll rail with header + `See ›` affordance |
| `src/features/apps/useApps.ts` | switched to `GET /api/js-apps`, drops the client-side `reachy_mini_js_app` filter, parses `categories` and optional `taxonomy` from the payload |
| `src/features/apps/types.ts` | `AppEntry` gains `categories: string[] \| null` |
| `src/features/apps/categoryTaxonomy.ts` | new: passive mirror of the server taxonomy (display label + emoji + render order). No `id -> category` mapping, no inference. |
| `src/features/apps/usePinnedApps.ts` | new: hook reading/writing `localStorage` pinned-ids |
| `src/features/apps/useFilteredApps.ts` | new: hook composing `useApps` + search query + pin set + (optional) category bucketing into the derived view-model the tab consumes |

`AppIframeOverlay` and `RobotSessionScreen` are **not** touched.
The launch contract (`onOpen` -> overlay) is preserved.

---

## 9. Open questions

### Mobile UI

1. **Pin ordering.** Insertion order, alphabetical, or
   drag-to-reorder? V1 picks insertion order (simpler, no UI
   needed). Drag-to-reorder is V1.5 if users complain.
2. **Pinned tile glyph.** Emoji-only vs emoji + 1-line name? V1
   keeps the name (the emoji alone is too ambiguous for
   look-alike apps like the two `🤖` Talk-with-* entries).
3. **Search within a rail.** Do we expose a per-rail search? V1
   says no; the global search is enough at this catalog size.
4. **Sort within "ALL APPS"**. V1 hardcodes "by likes desc". A
   future control could expose `recent` / `alphabetical`.
5. **Empty pinned rail first-run.** Section 4.1 says we omit
   the rail entirely. Alternative: show a single-tile
   onboarding rail ("Long-press any app to pin it"). Decide at
   wireframe review.

### Server contract (must be confirmed with the website PR)

6. **`categories` cardinality.** Single value vs array? Spec
   above assumes `string[]` (an app can be both "voice" and
   "tools"). If the server picks a single string, the mobile
   normaliser wraps it in an array on read (cheap, keeps the
   downstream code one-shape).
7. **Where does the rail emoji + label live?** Two options:
   - Server publishes `taxonomy` in every `/api/js-apps`
     response. Mobile mirror is a fallback only.
   - Taxonomy is a static contract, not in the payload. Mobile
     mirror is the only source of display metadata.
   V1 spec accepts both; the mobile code is structured to prefer
   the server-published taxonomy when present.
8. **App with multiple `categories`.** Does the app render in
   every matching rail (duplicated tile), or only in the first
   matching one? Spec defaults to **every matching rail**:
   discovery wins, the catalog is small enough that the visual
   redundancy is negligible (cap at most 4 rails in V1
   taxonomy).
9. **Phase 1 ETA.** The redesign is gated on `/api/js-apps`
   being live (Section 5.3). Confirm before merging the mobile
   PR.
