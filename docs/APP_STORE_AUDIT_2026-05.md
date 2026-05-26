# App Store iOS - submission readiness audit

> Status: audit / pre-submission gap analysis
> Last reviewed: 2026-05-26
> Owner: mobile team
> Companion to: [`APP_STORE_COMPLIANCE.md`](./APP_STORE_COMPLIANCE.md)
> (which lays out the policy framework and the pre-submission action
> plan)

This document answers a different question from the compliance plan:

> **Where do we stand TODAY against the 2026-05-10 checklist, and
> what would actually block a TestFlight + App Store submission if
> we built the bundle this afternoon?**

Short answer: the **shell is ~70% submission-ready**. The hard
client-side UGC work is done. The blockers that remain are:

1. **The OpenAI API key is baked into the bundle** (1 hard blocker,
   non-Apple but ToS-breaking).
2. **No server-side kill switch on the catalog** (1 hard Apple UGC
   blocker).
3. **No pre-publication moderation pipeline** (1 hard Apple UGC
   blocker).
4. **App Store Connect paperwork** (privacy nutrition label, age
   rating, App Review notes).

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
- Iframe `allow` list ([`AppIframeOverlay.tsx:714`](../src/ui/panels/apps-list/AppIframeOverlay.tsx))
  uses scoped tokens, **better** than what the compliance doc
  originally outlined:

  ```
  allow="microphone 'src'; camera 'src'; geolocation 'src';
         autoplay 'src'; clipboard-read 'src'; clipboard-write 'src'"
  ```

  Each capability is restricted to the iframe's own origin (`'src'`),
  not delegated globally. Geolocation is new vs. the original list
  and is justified by location-aware Spaces.
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
NSLocationWhenInUseUsageDescription - third-party Spaces (geolocation)
```

Plus the right orientation locks (portrait), `UIRequiresFullScreen
= true` (no iPad Split View resizing the WKWebView mid-WebRTC), and
`UIBackgroundModes = audio` for the OpenAI Realtime pipeline. Each
key is well-commented in `src-tauri/Info.plist` so the next time
someone refactors it, the rationale is right there.

### 1.5 Bundle identity

```json
"productName": "Reachy Mini",
"identifier":  "com.pollen-robotics.reachy-mini",
"version":     "0.6.4",
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

### 2.1 OpenAI API key baked into the bundle (CRITICAL, non-Apple)

Source: [`src/features/conversation/engine/settings.ts:113`](../src/features/conversation/engine/settings.ts)

```ts
const BUILD_TIME_OPENAI_KEY: string =
  (import.meta.env?.VITE_OPENAI_API_KEY as string | undefined) ?? '';
```

The `.env.example` and the file header self-label this as
"TEMPORARY". GitHub Actions
([`build-mobile.yml`](../.github/workflows/build-mobile.yml))
injects the same key from a repo secret at CI build time. The key
ends up readable inside the shipped `.ipa`.

**Why this blocks a public release, even outside Apple:**

1. **OpenAI Terms of Service** explicitly forbid embedding an API
   key in a distributed client. Account suspension is on the table
   the first time a reviewer / researcher extracts it.
2. **Cost exposure**: anyone with the `.ipa` can pull the key and
   run unlimited Realtime API calls on Pollen's quota. There is no
   client-side rate limit that survives a determined attacker.
3. **Apple 5.1.2**: end-user audio is shipped to a third party
   (OpenAI) over a connection the app itself authenticates. The
   privacy nutrition label needs to disclose this, and the App
   Review notes need to explain the data flow. Doable, but the
   reviewer's first question will be "how do you prevent abuse if
   your key leaks?".

**Fix** (in order of preference):

1. **Server-issued ephemeral keys**: stand up a small endpoint on
   `pollen-robotics-reachy-mini.hf.space` (or any other Pollen-controlled
   surface) that calls `POST /v1/realtime/sessions` with the
   master key and returns the resulting ephemeral key to the mobile
   client. The mobile client never sees the long-lived key, and the
   server can rate-limit per HF user.
2. **User OAuth on OpenAI**: heavier UX, but every user pays from
   their own quota. Removes Pollen from the loop entirely.

Either fix removes the build-time injection from `.env.local`,
`build-mobile.yml`, and `settings.ts`. The localStorage debug
escape hatch can stay for dev.

Effort: 1-2 days backend + 0.5 day mobile rewire.

### 2.2 No server-side catalog kill switch

`GET https://pollen-robotics-reachy-mini.hf.space/api/apps` returns
every Space tagged `reachy_mini_js_app`. The tag is self-attributed
by the Space author. There's no `mobile_visible: true` filter and
no `?surface=mobile` query param the catalog endpoint honours.

Concrete consequences:

- If a hostile or just inappropriate Space appears in the catalog,
  we can't remove it without publishing an iOS update (1-2 weeks
  review minimum).
- App Review will explicitly ask "how do you take down a non-compliant
  mini-app?" for any UGC catalog. There's no good answer today.

The client-side `useHiddenAuthors` is a per-user mitigation; it is
not the platform-level kill switch the compliance doc § 6.2.2
asks for.

Effort: 1 day on the catalog backend (HF Space owner: ask
whoever maintains `pollen-robotics-reachy-mini`).

### 2.3 No pre-publication moderation

Today, the only gate between "Space exists" and "Space appears in
mobile" is the author-applied tag. With the "vibe coding" hypothesis
(LLM-generated apps published quickly to HF Spaces), the catalog
will grow faster than a human can pre-review.

Minimum viable v1 (compliance doc § 6.2.1):

- Run an off-the-shelf text classifier on title + description +
  README.
- If clean -> flip `mobile_visible: true` automatically.
- If suspicious -> human review queue.

Without this, the kill switch in 2.2 is purely reactive. Apple
won't ask for the pre-publication pipeline by name, but the
reviewer red-teaming the app with "let me publish a Space with X
inappropriate content and see if it lands in the mobile catalog"
is a real risk path.

Effort: 3 days for v1, ongoing for model tuning.

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

### 3.1 The postMessage contract doc has drifted

`APP_STORE_COMPLIANCE.md` § 2.4 says the bridge is a single message
type:

```js
{ source: 'reachy-mini-shell', kind: 'hf-token', token }
```

The shipped code in [`AppIframeOverlay.tsx`](../src/ui/panels/apps-list/AppIframeOverlay.tsx)
sends FOUR message kinds today:

| `source` | `kind` | Purpose |
|---|---|---|
| `reachy-mini-shell` | `hf-token` | HF access token handover |
| `reachy-mini-shell` | `theme` | Live light/dark theme switch |
| `reachy-mini-shell` | `embed-config` | "You're inside the mobile shell" hint so the embed suppresses its own chrome |
| `reachy-mini` | `host:init` | `@reachy-mini/host/lib/protocol#HostInitMsg` payload for SDK-aware Spaces |

All four are host -> iframe (no iframe -> host messages are consumed
yet). Still, the compliance doc needs to be updated to list all
four, with rationale per message and a "no incoming messages
consumed" note, so it stays the source of truth a reviewer can be
pointed at.

Effort: 0.5 day.

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

- [ ] **(2.1)** Move the OpenAI API key off the bundle: ephemeral
      keys from a Pollen-controlled endpoint, OR user OAuth on
      OpenAI. Remove the build-time injection from `.env.local`,
      GitHub Actions, and `settings.ts`.
- [ ] **(2.2)** Server-side kill switch on the catalog
      (`mobile_visible: true` + `?surface=mobile` filter).
- [ ] **(2.3)** Pre-publication automated moderation on
      title/description/README.
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
| OpenAI ephemeral keys backend | 1-2 days | Need a Pollen-controlled HF Space or server |
| OpenAI ephemeral keys mobile rewire | 0.5 day | After backend |
| Catalog kill switch | 1 day | Coordination with `pollen-robotics-reachy-mini` owner |
| Catalog moderation v1 | 3 days | Off-the-shelf classifier choice |
| Privacy Policy review + update | 0.5-1 day | Legal review |
| App Store Connect paperwork | 0.5 day | Privacy Policy URL ready |
| Bridge doc update + capability audit | 1 day | None |

**Realistic critical path**: ~2 weeks calendar from "start" to
"submission-ready bundle", with the catalog backend work being the
long pole.

---

## 6. Open questions for product

1. Do we want **ephemeral keys** (Pollen pays, we monitor abuse)
   or **user OAuth** (each user pays, Pollen is out of the loop)?
   The first is faster to ship, the second is cleaner for the
   business model long term.
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
