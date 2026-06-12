# App Store iOS - submission readiness audit

> Status: audit / pre-submission gap analysis
> Last reviewed: 2026-05-29
> Owner: mobile team
> Companion to: [`APP_STORE_COMPLIANCE.md`](./APP_STORE_COMPLIANCE.md)
> (which lays out the policy framework and the pre-submission action
> plan)

This document answers a different question from the compliance plan:

> **Where do we stand TODAY against the 2026-05-10 checklist, and
> what would actually block a TestFlight + App Store submission if
> we built the bundle this afternoon?**

Short answer: the **shell is submission-ready on the engineering side**.
The hard client-side UGC work is done, the OpenAI key blocker is
resolved (the bundle no longer ships a long-lived key), and the two
server-side UGC blockers (kill switch + pre-publication moderation) have
since shipped in the `reachy_mini_api` Space. What remains is paperwork:

1. ~~**The OpenAI API key is baked into the bundle**~~ **RESOLVED
   (2026-05)**: the bundle no longer carries a long-lived OpenAI key.
   Voice conversation now mints a per-user, short-lived ephemeral key
   via the API Space's `/api/openai/ephemeral` endpoint, gated by the
   user's Hugging Face token. See § 2.1.
2. ~~**No server-side kill switch on the catalog**~~ **RESOLVED
   (2026-06)**: `/api/js-apps` now enforces a hand-edited
   `config/blocked-app-list.json` killswitch on the official dataset.
   See § 2.2.
3. ~~**No pre-publication moderation pipeline**~~ **RESOLVED
   (2026-06)**: `/api/js-apps` runs a two-layer moderation pipeline
   (regex hard-block + LLM classifier) and only serves visible apps.
   See § 2.3.
4. **App Store Connect paperwork** (privacy nutrition label, age
   rating, App Review notes) - the only remaining gate.

The rest is hygiene. Details below.

---

## 1. What's already in place (the good)

These are the items from `APP_STORE_COMPLIANCE.md` that ship today
in `main` and would be cocheable for an App Review pass.

### 1.1 Guideline 4.7 + 2.5.2 architecture

- Mini-apps run in cross-origin `*.hf.space` iframes. No native code
  / WASM / bytecode is downloaded.
- Bridge between shell and iframe is `postMessage` only, host -> iframe,
  with a finite (but slightly larger than § 2.4 of the compliance doc
  describes) set of message kinds. See section 4 below for the gap.
- Iframe `allow` list ([`AppIframeOverlay.tsx:864`](../src/ui/panels/apps-list/AppIframeOverlay.tsx))
  uses scoped tokens, **better** than what the compliance doc
  originally outlined:

  ```
  allow="microphone 'src'; camera 'src';
         autoplay 'src'; clipboard-read 'src'; clipboard-write 'src'"
  ```

  Each capability is restricted to the iframe's own origin (`'src'`),
  not delegated globally. Geolocation was previously delegated but
  removed (2026-06) — no shipping Space surfaces a location feature,
  and an unused permission prompt is an App Review red flag for a
  capability we don't actually use.
- CSP in [`tauri.conf.json:25`](../src-tauri/tauri.conf.json) is tight:
  `frame-src https://*.hf.space` (no wildcard origins), `script-src
  'self' 'unsafe-inline' https://cdn.jsdelivr.net` (D3-ish CDN only
  for the host shell).

### 1.2 Guideline 1.2 (UGC) - all four pillars

| Pillar | Implementation | Source |
|---|---|---|
| Report mechanism | "Report this app" item in the kebab menu, deeplinks `<spaceUrl>?report=true` to HF Trust & Safety | `src/ui/panels/apps-list/AppActionsMenu.tsx` |
| Block abusive users | "Hide apps from <author>" in the same menu, persisted in `useHiddenAuthors`, revocable from Help & Support | `src/features/apps/useHiddenAuthors.ts` |
| EULA / first-launch consent | `EulaConsentModal` blocks the UI on first launch with 3 disclosures (voice, third-party apps, HF sign-in) + Privacy Policy + ToS links | `src/ui/screens/EulaConsentModal.tsx` |
| Contact information | Help & Support overlay with `support@pollen-robotics.com`, docs, Discord, GitHub, Privacy Policy, ToS, plus a "Hidden authors" revoke list | `src/ui/screens/scan/HelpAndSupportOverlay.tsx` |

Note: the moderation backend is delegated to Hugging Face Trust &
Safety (no Pollen-operated `/api/apps/report` endpoint). That's a
valid design choice but the App Review notes need to call it out
explicitly so the reviewer doesn't expect a Pollen-side moderation
queue.

### 1.3 Guideline 4.x - in-app sign-in

- `tauri-plugin-auth-session = "0.2"` is pinned in
  [`src-tauri/Cargo.toml:51`](../src-tauri/Cargo.toml). On iOS, this
  wraps `ASWebAuthenticationSession` so the OAuth dance never leaves
  the app for Safari.
- The loopback bridge lives in [`src-tauri/src/oauth.rs`](../src-tauri/src/oauth.rs):
  HF still redirects to `http://localhost:8000/...` (registered
  redirect URI, unchanged), our listener emits a 302 to
  `reachymini://oauth/callback?<query>`, and the auth session
  intercepts the custom scheme.

The Android intent filter for the `reachymini` scheme is still
pending per the compliance doc § 2.6 (out of scope for iOS-only
submission).

### 1.4 Info.plist hygiene (5.1.x)

All required usage strings present and honest:

```text
NSMicrophoneUsageDescription      - voice conversation + third-party Spaces
NSCameraUsageDescription          - third-party Spaces (vision / AR / barcode)
NSLocalNetworkUsageDescription    - daemon HTTP on robot:8000
```

> `NSLocationWhenInUseUsageDescription` was previously declared but
> removed (2026-06) ahead of the next store validation pass. No
> shipping Space surfaces a location feature, and an unused
> permission prompt is an App Review red flag. Restore the key (and
> the iframe `geolocation 'src'` token) if a Space ever needs
> `navigator.geolocation`.

Plus the right orientation locks (portrait), `UIRequiresFullScreen
= true` (no iPad Split View resizing the WKWebView mid-WebRTC), and
`UIBackgroundModes = audio` for the OpenAI Realtime pipeline. Each
key is well-commented in `src-tauri/Info.plist` so the next time
someone refactors it, the rationale is right there.

### 1.5 Bundle identity

```json
"productName": "Reachy Mini",
"identifier":  "com.pollen-robotics.reachy-mini",
"version":     "0.6.5",
"iOS.developmentTeam": "4KLHP7L6KP"
```

Reverse-DNS identifier under the official `pollen-robotics`
namespace. **Verify before submission** that team ID `4KLHP7L6KP`
matches the Pollen Robotics Apple Developer Program org, not a
personal account.

### 1.6 Framing (Guideline 3.2.2)

User-visible strings audit: zero hits for "App Store", "Marketplace",
"Download apps", "Install apps" in the rendered UI. The only matches
in source are in JSDoc / inline comments inside
`AppCompactTile.tsx`, `AppRail.tsx`, and `buildSpaceUrls.ts`,
all reviewer-invisible. The current vocabulary in the UI ("Apps",
"Launch", "Open") matches the compliance doc § 2.5 recommendations.

---

## 2. What's missing - the actual blockers

### 2.1 OpenAI API key baked into the bundle - RESOLVED (2026-05)

> **Status: fixed.** This was the #1 hard blocker in the original
> 2026-05-26 audit. It has since been resolved by option 1 below
> (server-issued ephemeral keys). The section is kept for historical
> context and so the App Review data-flow story stays documented.

**What used to be the problem.** The shell baked a long-lived OpenAI
API key into the bundle (`VITE_OPENAI_API_KEY` ->
`BUILD_TIME_OPENAI_KEY` in `settings.ts`, injected by
`build-mobile.yml` from a repo secret). The key was extractable from
the shipped `.ipa`, which violates OpenAI's ToS for distributed
clients and exposed Pollen's quota to anyone who pulled it apart.

**How it was fixed.** The build-time injection is gone from
`settings.ts`, `.env.example`, and `build-mobile.yml` (the workflow no
longer needs an `OPENAI_API_KEY` repo secret). Voice conversation now
follows the server-issued ephemeral-key path:

1. The phone holds an HF token (acquired via the in-app
   `ASWebAuthenticationSession` OAuth flow).
2. [`ephemeral-key.ts`](../src/features/conversation/engine/ephemeral-key.ts)
   POSTs that token as `Authorization: Bearer <hf_token>` to the
   website Space's `/api/openai/ephemeral` endpoint.
3. The server validates the HF token (`whoami-v2`), rate-limits per
   HF user, then mints a short-lived (~10 min) OpenAI Realtime client
   secret using the master `OPENAI_API_KEY` that stays in the Space's
   secrets.
4. The `ek_…` value is used as the bearer for the
   `POST /v1/realtime/calls` GA handshake. The long-lived key never
   reaches the client.

**Residual App Review work (still required).** Even though the key is
gone, the data flow still needs disclosure:

- **Apple 5.1.2**: end-user audio is shipped to a third party (OpenAI)
  over the WebRTC tunnel. The privacy nutrition label must disclose
  it, and the App Review notes should explain the ephemeral-key
  brokering so the reviewer doesn't ask "how do you prevent abuse if
  your key leaks?" (answer: there is no long-lived key in the bundle;
  access is HF-token-gated and rate-limited server-side).

Effort remaining: 0 (engineering); the disclosure is folded into the
§ 2.4 paperwork.

### 2.2 No server-side catalog kill switch - RESOLVED (2026-06)

> **Status: fixed.** Implemented in the `reachy_mini_api` Space
> (`server/index.js`). Kept here for the App Review data-flow story.

`GET /api/js-apps` now computes a `mobile_visible` flag per app and, by
default, filters out everything where `mobile_visible === false` before
the catalog reaches any client (`?includeHidden=true` is the admin/debug
escape). The highest-precedence input to that flag is a hand-edited
`config/blocked-app-list.json` on the official dataset
(`pollen-robotics/reachy-mini-official-app-store`):

- Anyone with write access to the dataset blocks a Space by adding its
  ID to `blocked-app-list.json`. The in-memory `blockedSet` is refreshed
  alongside the apps cache, so the takedown propagates within the cache
  TTL - **no iOS update required**.
- This is the platform-level kill switch the compliance doc § 6.2.2
  asked for; the client-side `useHiddenAuthors` remains as a per-user
  mitigation on top.

So the App Review question "how do you take down a non-compliant
mini-app?" now has a concrete answer: a one-line dataset edit.

### 2.3 No pre-publication moderation - RESOLVED (2026-06)

> **Status: fixed.** Implemented in the `reachy_mini_api` Space
> (`server/moderate.js` + `server/moderationCache.js`, wired into
> `/api/js-apps`). Kept here for the App Review data-flow story.

Every JS app surfaced by `/api/js-apps` now runs through a two-layer
moderation pipeline before it can be visible:

1. **Regex prescreen** (synchronous, free): a small list of
   unambiguous hard-block patterns (explicit sexual content, CSAM
   signals, obvious scams/malware, gore). A hit is an immediate block.
2. **LLM classifier** (HF Inference, ~1 s, cached): for everything the
   regex misses, an 8B model returns a structured verdict against a
   *closed* policy taxonomy (`sexual`, `hate`, `violence`, `illegal`,
   `scam_malware`, `self_harm`, `none`) with `allow` / `block` /
   `review` decisions.

`computeVisibility()` combines this with the manual block-list (§ 2.2,
highest precedence) and the official-app allowlist to set
`mobile_visible`. The pipeline is **fail-open** (a transient LLM hiccup
leaves an app pending/visible rather than emptying the catalog), with
the regex layer and manual block-list as the hard backstops.

This closes the red-team path "publish a Space with inappropriate
content and see if it lands in the mobile catalog": objectionable
Spaces are blocked before they reach any client.

### 2.4 App Store Connect paperwork (gating the submission form)

Not code work, but you can't submit without these:

- **Privacy Nutrition Label** populated, including:
  - Account info (HF username + token storage)
  - Audio (mic capture, sent to OpenAI Realtime, not stored on
    Pollen servers)
  - Identifiers (HF user id, robot peer id)
  - User content (text from conversation transcripts if we surface
    them anywhere)
- **Age rating questionnaire** -> answer "Yes" to user-generated
  content + Internet access -> expect a **12+** rating. Plan for
  it.
- **App Review notes** drafted, citing guideline 4.7 explicitly and
  naming Roblox / Telegram Mini Apps / Sonos / Hue as precedents.
  Mention that HF Trust & Safety is the moderation backend and
  point to the in-app Report flow.
- **Privacy Policy URL** publicly reachable. Today we link to
  `https://www.pollen-robotics.com/personal-data-protection-charter/`.
  **Verify** that this document covers:
  - HF account info (token, username) used for Hub auth.
  - Audio sent to OpenAI Realtime (purpose, retention, no
    server-side storage on Pollen side).
  - Third-party Spaces operating independently with their own
    policies.
  - The Report and Block affordances available in-app.

Effort: 0.5-1 day, mostly legal review of the existing privacy
charter.

---

## 3. Secondary points - worth fixing before submission

### 3.1 The postMessage contract - RECONCILED (2026-05-29)

The shipped code in [`AppIframeOverlay.tsx`](../src/ui/panels/apps-list/AppIframeOverlay.tsx)
sends FOUR message kinds today:

| `source` | `kind` | Purpose |
|---|---|---|
| `reachy-mini-shell` | `hf-token` | HF access token handover |
| `reachy-mini-shell` | `theme` | Live light/dark theme switch |
| `reachy-mini-shell` | `embed-config` | "You're inside the mobile shell" hint so the embed suppresses its own chrome |
| `reachy-mini` | `host:init` | `@reachy-mini/host/lib/protocol#HostInitMsg` payload for SDK-aware Spaces |

All four are host -> iframe (no iframe -> host messages are consumed
yet). `APP_STORE_COMPLIANCE.md` § 2.4 has been updated to list all
four with per-message rationale plus the "no incoming messages
consumed" note, so it stays the source of truth a reviewer can be
pointed at.

### 3.2 OpenAI Realtime data flow not disclosed in EULA

The first-launch `EulaConsentModal` says:

> Your microphone audio is sent to OpenAI Realtime to power Reachy
> Mini's replies. Audio is not stored on our servers.

Good. But it doesn't mention:

- OpenAI **may** retain audio per their data usage policy (we sign
  the consumer ToS).
- Tool calls return to the model with the robot's state.

Acceptable as-is for Apple, but worth aligning with whatever the
final Privacy Policy says about OpenAI's data handling, so the
in-app text and the public policy don't contradict each other.

### 3.3 `developmentTeam` ID needs verification

`"developmentTeam": "4KLHP7L6KP"` in `tauri.conf.json`. Confirm
this is the Pollen Robotics organisation Apple Developer ID, not a
team member's personal account. App Store distribution **requires**
an organisation account; a personal team can build TestFlight but
not ship publicly.

### 3.4 `tauri-plugin-os` exposes `platform()` and `osType()` to the WebView

[`Cargo.toml:28`](../src-tauri/Cargo.toml) registers `tauri-plugin-os`.
The capability file at `src-tauri/capabilities/default.json` likely
allows the WebView to read `platform`, `version`, `family`, `hostname`.
None of those are PII, but a privacy-conscious reviewer may ask
why hostname is exposed if it is (it's the device hostname on
desktop, "unknown" or similar on iOS). Worth auditing
`default.json` and tightening to the smallest viable allowlist
before submission.

### 3.5 `UIBackgroundModes = audio` will trigger a reviewer question

The justification is in the `Info.plist` comment, which is great
for future devs but invisible to App Review. The App Review notes
should pre-empt the question:

> The app uses the `audio` background mode to keep the WebRTC peer
> connection to OpenAI Realtime alive while the device is locked,
> so a voice conversation in progress isn't dropped when the user
> pockets the phone. Mirrors Discord / Slack / Google Assistant
> background-audio entitlements.

Without this proactive note, the reviewer will ask, you'll
respond, and the review cycle takes an extra round-trip.

---

## 4. Updated submission checklist (replaces § 7 of the compliance doc)

Drop-in replacement for `APP_STORE_COMPLIANCE.md` § 7, in priority
order. Sourced from the audit above so it reflects what's actually
needed today.

### 4.1 Hard blockers (cannot submit without these)

- [x] **(2.1)** ~~Move the OpenAI API key off the bundle~~ **DONE**:
      ephemeral keys from the API Space's `/api/openai/ephemeral`
      endpoint. Build-time injection removed from `.env.example`,
      GitHub Actions, and `settings.ts`.
- [x] **(2.2)** ~~Server-side kill switch on the catalog~~ **DONE**:
      `mobile_visible` filter on `/api/js-apps` driven by a hand-edited
      `config/blocked-app-list.json` on the official dataset.
- [x] **(2.3)** ~~Pre-publication automated moderation~~ **DONE**:
      two-layer regex + LLM pipeline on title/description/README in
      `server/moderate.js`, enforced via `mobile_visible`.
- [ ] **(2.4)** Privacy Nutrition Label populated in App Store Connect.
- [ ] **(2.4)** Age rating questionnaire filled; expect 12+.
- [ ] **(2.4)** App Review notes drafted (4.7 citation + precedents
      + moderation backend = HF Trust & Safety).
- [ ] **(2.4)** Privacy Policy URL publicly reachable and covering
      all data flows (HF token, audio to OpenAI, third-party Spaces).

### 4.2 Soft blockers (cheap fixes, do before submission)

- [ ] **(3.1)** `APP_STORE_COMPLIANCE.md` § 2.4 updated to list all
      four `postMessage` kinds with rationale per kind.
- [ ] **(3.2)** EULA copy reconciled with the Privacy Policy
      regarding OpenAI's data handling.
- [ ] **(3.3)** `developmentTeam: 4KLHP7L6KP` confirmed to be the
      Pollen Robotics organisation.
- [ ] **(3.4)** `src-tauri/capabilities/default.json` audited and
      tightened.
- [ ] **(3.5)** App Review notes pre-empt the
      `UIBackgroundModes = audio` question.

### 4.3 Out of scope for iOS-only submission

- [ ] Android intent filter for `reachymini://` scheme (compliance
      doc § 2.6) - only needed for Google Play.
- [ ] Google Play Data Safety form - only needed for Google Play.

### 4.4 Already in place (no action needed, listed for sanity)

- [x] In-app sign-in via `ASWebAuthenticationSession` (1.3)
- [x] UGC pillar #1 - Report mechanism (1.2)
- [x] UGC pillar #2 - Block author (1.2)
- [x] UGC pillar #3 - EULA / first-launch consent (1.2)
- [x] UGC pillar #4 - Contact information (1.2)
- [x] Iframe `allow` list scoped to `'src'` (1.1)
- [x] CSP `frame-src https://*.hf.space` (1.1)
- [x] All required `NSXxxUsageDescription` strings present (1.4)
- [x] Portrait lock + `UIRequiresFullScreen` (1.4)
- [x] No forbidden marketing terms in user-visible strings (1.6)

---

## 5. Time-to-submit estimate

Assuming sequential work, single owner per chantier:

| Workstream | Effort | Dependency |
|---|---|---|
| ~~OpenAI ephemeral keys backend~~ | done | shipped 2026-05 |
| ~~OpenAI ephemeral keys mobile rewire~~ | done | shipped 2026-05 |
| ~~Catalog kill switch~~ | done | shipped 2026-06 (`reachy_mini_api`) |
| ~~Catalog moderation v1~~ | done | shipped 2026-06 (`reachy_mini_api`) |
| Privacy Policy review + update | 0.5-1 day | Legal review |
| App Store Connect paperwork | 0.5 day | Privacy Policy URL ready |
| Bridge doc update + capability audit | 1 day | None |

**Realistic critical path**: the engineering blockers are cleared
(OpenAI key migration, catalog kill switch, and moderation all shipped).
What's left is App Store Connect paperwork + the Privacy Policy review,
so the remaining critical path is ~1-2 days of non-engineering work.

---

## 6. Open questions for product

1. ~~Do we want **ephemeral keys** or **user OAuth**?~~ **Decided:
   ephemeral keys.** Pollen's master key mints short-lived,
   HF-token-gated, per-user rate-limited keys via
   `/api/openai/ephemeral`. Revisit user-OAuth-on-OpenAI only if the
   business model needs each user to pay from their own quota.
2. The kill switch is server-side; **who operates it**? Pollen
   only, or any HF moderator? The Apple-safe answer is "Pollen
   only", with author input as a hint.
3. **First-submission go/no-go criteria**: do we ship as soon as
   the four hard blockers are green, or do we wait for the
   moderation pipeline to mature beyond v1?
4. **TestFlight first**? A TestFlight internal-test build can
   already ship today (TestFlight doesn't enforce the catalog
   moderation question), which would let us iterate on the OpenAI
   key migration in real builds without the App Store review loop.
   Strongly recommended.

---

## 7. References

- [`APP_STORE_COMPLIANCE.md`](./APP_STORE_COMPLIANCE.md) - policy framework + original action plan
- [`AGENTS.md`](../AGENTS.md) - architecture + layer rules
- [`README.md`](../README.md) - stack overview
- [Apple App Store Review Guidelines, section 4.7](https://developer.apple.com/app-store/review/guidelines/#mini-apps-mini-games-streaming-games-chatbots-plug-ins-and-game-emulators)
- [Apple App Store Review Guidelines, section 1.2 (UGC)](https://developer.apple.com/app-store/review/guidelines/#user-generated-content)
- [OpenAI API key safety best practices](https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety)
- [OpenAI Realtime API ephemeral tokens](https://platform.openai.com/docs/guides/realtime-webrtc)
