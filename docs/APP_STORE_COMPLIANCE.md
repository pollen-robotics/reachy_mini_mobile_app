# App Store & Play Store Compliance

> Status: research / pre-submission analysis
> Last reviewed: 2026-05-29
> Owner: mobile team
> Scope: the in-app "Apps" tab that lists Hugging Face Spaces (JS
> apps, pre-filtered server-side) and embeds them in a WebView iframe.

This document answers a single question: **can the in-app catalog of
third-party Reachy Mini apps pass review on Apple App Store and Google
Play Store?**

Short answer: **yes**, the concept is reviewable, but it sits in a
sensitive area (user-generated content + mini-app distribution) so the
shell needs four concrete safeguards before the first submission.
Long answer below.

---

## 1. What the feature actually is, technically

The reviewer will judge what the app *does*, not what we call it. So
let us first write down precisely what the Apps tab does today.

### 1.1 Data flow

1. On mount, `useApps()`
   ([`src/features/apps/useApps.ts`](../src/features/apps/useApps.ts))
   fetches a public, unauthenticated JSON catalog:

   ```
   GET https://pollen-robotics-reachy-mini.hf.space/api/js-apps
   ```

2. The endpoint already pre-filters JS apps server-side (the client
   no longer filters on the `reachy_mini_js_app` tag itself) and
   attaches an LLM-classified `categories` array per app. The hook
   normalizes entries into `AppEntry { id, name, description,
   spaceUrl, author, isOfficial, sdk, emoji, iconUrl, tags, likes,
   categories, ... }`.

3. `AppsTabView` renders a virtualized list of `AppCard`s. Tapping
   one calls `onOpen(app)`.

4. `AppIframeOverlay`
   ([`src/ui/panels/apps-list/AppIframeOverlay.tsx`](../src/ui/panels/apps-list/AppIframeOverlay.tsx))
   builds a runtime URL with `buildAppEmbedUrl()`
   ([`src/features/apps/buildEmbedUrl.ts`](../src/features/apps/buildEmbedUrl.ts))
   pointing at the Space's public host:

   ```
   sdk=static          → https://<slug>.static.hf.space/
   sdk=docker|gradio|… → https://<slug>.hf.space/
   ```

5. The overlay mounts a single `<iframe src="https://*.hf.space/...">`
   with the capabilities scoped to the iframe's own origin (`'src'`):

   ```
   allow="microphone 'src'; camera 'src';
          autoplay 'src'; clipboard-read 'src'; clipboard-write 'src'"
   ```

   It then hands the embedded app context over `postMessage` (HF
   access token, theme, embed-config, and the SDK `host:init`
   payload) so the app can skip its own OAuth round-trip and match
   the shell's look. See § 2.4 for the full message contract.

### 1.2 Crucial properties for the review

| Property | Value | Why it matters |
|---|---|---|
| Native code download | **No** | 4.7 / 2.5.2 compliance |
| Bytecode / WASM download | **No** | 4.7 / 2.5.2 compliance |
| JS-only mini-apps in WebView | **Yes** | Explicitly allowed by 4.7 |
| Iframes are sandboxed (cross-origin) | **Yes** | Default browser sandbox |
| Bridge API exposed to mini-apps | `postMessage` only, four host -> iframe message kinds (see § 2.4) | Auditable, finite |
| Tauri plugins reachable from mini-apps | **No** (different origin) | No native escape hatch |
| Free for users | **Yes** | No IAP requirement triggered |

These properties are the foundation. Every argument below assumes they
remain true. The day a mini-app starts downloading native code, calling
arbitrary Tauri commands, or charging for digital goods, the review
calculus changes.

---

## 2. Apple App Store

### 2.1 The relevant guidelines

The five guidelines a reviewer will check, in order of impact:

| Guideline | Topic | Impact for us |
|---|---|---|
| **4.7** | Mini apps, mini games, chatbots, plug-ins, game emulators | **Enables the whole concept** |
| **1.2** | User-generated content | **Highest blocker risk** |
| **2.5.2** | Code execution | OK if 4.7 conditions hold |
| **3.2.2** | Unacceptable: app-like discovery surface | Watch the framing |
| **5.1.x** | Privacy (data collection, permissions) | Standard work |

### 2.2 Guideline 4.7 - the enabling rule

Apple updated 4.7 in 2024 to formally allow apps to host third-party
"software" (mini apps, mini games, chatbots, plug-ins, AI agents)
provided that:

1. They are written in **HTML5, JavaScript, or CSS** and run in a
   WebView. Native code, bytecode, or arbitrary executables are **not**
   permitted.
2. The host app is **responsible for ensuring** the mini apps comply
   with the rest of the App Store Review Guidelines.
3. If the host charges for the mini apps, **In-App Purchase** must be
   used. Free distribution does not trigger this requirement.
4. The host must provide an **age rating** that reflects the highest
   age rating of any mini app it surfaces.

Approved precedents under 4.7 (or its predecessors): Roblox, Telegram
Mini Apps, WeChat, Line, Discord activities, the Sonos / Spotify-like
service-discovery surfaces, Philips Hue's app integrations, Alexa
"Skills", IFTTT applets.

**Verdict on 4.7**: we are squarely inside the rule. Each Reachy Mini
app is a JS/HTML5 page served from a Hugging Face Space, embedded in
the WebView via an iframe. No native code, no bytecode, free.

### 2.3 Guideline 1.2 - User Generated Content - the real blocker

This is where most apps in our category get rejected on first
submission. The catalog is, technically, user-generated: any HF user
can publish a Space and add the `reachy_mini_js_app` tag to surface it
in the mobile app.

The guideline requires **all four** of the following:

1. **A method for filtering objectionable material** from being posted
   to the app.
2. **A mechanism to report offensive content** and timely responses to
   concerns.
3. **The ability to block abusive users** from the service.
4. **Published contact information** so users can easily reach you.

Today the app implements **zero** of these. Concretely:

- `AppCard` has a "Launch" button and nothing else. No "Report".
- `AppIframeOverlay` has a "Close" button and nothing else. No
  "Report this app".
- There is no EULA / Terms of Service prompt at first launch.
- There is no contact email surfaced in-app.
- There is no server-side blocklist that can hide a Space from the
  catalog without an App Store update.

Every one of these will be pointed at by App Review and will block
the submission until fixed. See section 6 for the concrete remediation
plan.

### 2.4 Guideline 2.5.2 - Code execution

> "Apps may not download, install, or execute code which introduces or
> changes features or functionality of the app, including other apps."

Read in isolation, this would prohibit our entire pattern. In practice
4.7 is the explicit carve-out: HTML5/JS in a WebView is allowed. The
review will check that:

- No `eval()` over downloaded blobs in the host shell.
- No dynamic Tauri plugin loading.
- The bridge between mini-apps and the host is finite and documented.
  Today it is **four** message shapes, all flowing **host → iframe**
  only. No iframe → host messages are consumed:

  | `source` | `kind` | Purpose |
  |---|---|---|
  | `reachy-mini-shell` | `hf-token` | HF access token handover (skip the embed's own OAuth) |
  | `reachy-mini-shell` | `theme` | Live light/dark theme switch |
  | `reachy-mini-shell` | `embed-config` | "You're inside the mobile shell" hint so the embed suppresses its own chrome |
  | `reachy-mini` | `host:init` | `@reachy-mini/host/lib/protocol#HostInitMsg` payload for SDK-aware Spaces |

  The contract is implemented in
  [`AppIframeOverlay.tsx`](../src/ui/panels/apps-list/AppIframeOverlay.tsx).
  Any new message kind must be added here with a security-review note
  so the surface stays finite and auditable.
- The iframe `allow` list is reasonable and matches the feature set.
  Today: `microphone 'src'; camera 'src'; autoplay 'src';
  clipboard-read 'src'; clipboard-write 'src'`. Each maps to a real
  feature (voice apps, camera-based apps, autoplay for music apps,
  clipboard for code-snippet apps), and each is scoped to the
  iframe's own origin via `'src'` rather than delegated globally.
  Geolocation was previously delegated but removed (2026-06): no
  shipping Space surfaces a location feature, and an unused
  `NSLocationWhenInUseUsageDescription` / `ACCESS_*_LOCATION` is an
  App Review / Play Console red flag.

**Verdict on 2.5.2**: we comply. The `postMessage` contract is
documented here and in `AGENTS.md`; keep both in sync so it stays
finite as new features land.

### 2.5 Guideline 3.2.2 - "Unacceptable" - the framing risk

> "Creating an interface for displaying third-party apps, extensions,
> or plug-ins similar to the App Store or as a general-interest
> collection."

This is the rule used to reject apps that look like alternative App
Stores. The line Apple draws in practice:

| Allowed | Rejected |
|---|---|
| Companion app for a hardware device that lists compatible experiences | Generic "directory of fun web apps" |
| Telegram listing chatbot mini-apps | App that just iframes random websites |
| Roblox listing user-made games | "Browse third-party iOS apps here" |
| Sonos listing music services | Listing apps that compete with installed iOS apps |

Our framing must therefore be: **"experiences and skills for the
Reachy Mini robot you own"**, not **"a catalog of cool web apps"**.

Concretely, the words to **avoid** in App Store metadata, screenshots,
in-app strings, and onboarding:

- "App Store" (also a trademark)
- "Marketplace"
- "Download apps"
- "Install apps"
- "Distribute apps"

The words to **prefer**:

- "Skills for your Reachy Mini"
- "Compatible experiences"
- "Library" / "Catalog"
- "Connected apps" / "Apps for your robot"
- "Launch" (we already use this on the card button - good)

The current code says "Apps" everywhere (`AppsTabView.tsx`, "Apps
available", emoji `🎒` etc.). "Apps" is fine; "App Store" is not.
Search the source for any forbidden term before submission. See
section 6.4.

### 2.6 Sign-in must stay in-app (poor-UX rejection)

Separate from the UGC blocker, Apple has tightened its review on flows
that hand the user off to Safari for OAuth. The typical rejection
wording is:

> "We noticed that the user is taken to the default web browser to
> sign in or register for an account, which provides a poor user
> experience."

This applies even when the external Safari flow is functionally
correct. The fix is to use [`ASWebAuthenticationSession`](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession)
(Apple's recommended API since iOS 13) so the user stays inside the
app. We do this via [`tauri-plugin-auth-session`](https://github.com/yanqianglu/tauri-plugin-auth-session)
which wraps `ASWebAuthenticationSession` on iOS/macOS and Chrome Custom
Tabs on Android.

Because Hugging Face's OAuth client `71146982-...` is registered with
only a loopback redirect URI (`http://localhost:8000/api/hf-auth/oauth/callback`),
and we did not want to ask HF to add a custom scheme, we keep the
loopback alive as a *bridge*: HF redirects to localhost, the Rust
listener responds with `HTTP/1.1 302` to `reachymini://oauth/callback?<query>`,
the auth session intercepts the custom scheme and resolves. See
[`src-tauri/src/oauth.rs`](../src-tauri/src/oauth.rs) and
[`src/features/auth/oauthLoopback.ts`](../src/features/auth/oauthLoopback.ts).

**Verdict on 2.7**: in-app sign-in is in place on iOS and macOS. The
Android intent filter for the `reachymini` scheme still needs to be
declared in `AndroidManifest.xml` once `src-tauri/gen/android/` is
generated (the plugin's README documents the snippet).

### 2.7 Privacy (5.1.x)

Standard work, but specific items to check:

- **Permission strings** in `Info.plist`:
  - `NSMicrophoneUsageDescription` - already needed for the voice
    conversation; mention it covers third-party apps too.
  - `NSCameraUsageDescription` - same.
  - `NSLocalNetworkUsageDescription` - if the daemon ever speaks
    over LAN HTTP.
- **Privacy nutrition label** must declare: HF account info, robot
  identifiers (peer id), microphone/camera, possibly user contact info
  if we add a "report" form.
- **HF token handling**: today the token rides in the URL fragment
  and `postMessage`. Fragments do not appear in HTTP referer headers;
  good. We should still document this in a public privacy policy.
- **Third-party data**: each embedded Space is operated by a third
  party. Our privacy policy must explicitly say "third-party apps you
  open from the catalog operate independently and are subject to the
  privacy policy of their author".

### 2.8 Age rating

UGC catalogs typically receive **12+** at minimum from Apple's
questionnaire because of "Infrequent/Mild Mature/Suggestive Themes"
implied by the unmoderated user content question. If the moderation
funnel is solid, 9+ is achievable. Plan for **12+**.

---

## 3. Google Play Store

Materially more permissive than Apple, but the policies that matter
have the same shape:

| Policy | Topic | Impact |
|---|---|---|
| **User-Generated Content** | Same four pillars as Apple 1.2 | High |
| **Deceptive Behavior** | Pretending to be official or stealing branding | Low |
| **WebView restrictions** | Apps that are just a wrapper of a website | Low (we are not) |
| **Permissions** | Microphone, camera, location | Standard |
| **Families policy** | If targeting kids | Out of scope |
| **Real-money purchases** | If we add IAP later | Out of scope |

Risk on Play Store: **low**. If we pass Apple, we pass Google. The
same UGC remediation (section 6) covers the Play Store UGC policy
verbatim, with the addition of:

- Listing on Play must include a Data Safety form (similar to Apple's
  privacy nutrition label).
- App must declare the WebView permission set in the manifest.
- If we want to unlock "kids" eligibility, we'd need a much heavier
  moderation pipeline. Plan for "Teen" / "Mature 13+" rating.

---

## 4. The "vibe coding" angle

The product hypothesis is that users will generate new apps quickly
(LLM-driven scaffolding, then publish to Hugging Face Spaces). This
**accelerates** the rate at which new entries appear in the catalog,
which **amplifies** the UGC moderation problem above. It does not
change the legal/policy shape of the problem.

What it does change in practice:

1. The catalog growth rate is high. Manual pre-review of every new
   Space is not viable. We need at least **automated** pre-publication
   checks (regex / classifier on title + description + emoji + tags
   + screenshots) before a Space gains the `reachy_mini_js_app` tag
   in the **mobile** filter.
2. The probability of a malicious or just inappropriate app
   appearing is non-trivial. We need a **server-side kill switch**
   that takes a Space out of the mobile catalog without an App Store
   update.
3. The probability of an app that misbehaves in the WebView (eats
   battery, opens popups, abuses microphone) is non-trivial. The
   `allow` list on the iframe is our last defense - keep it minimal.

Critically: **the fact that mini-apps are user-generated and the host
distributes them at runtime is fine under 4.7**. What is **not** fine
is doing it without the safeguards in section 6.

---

## 5. Precedents to cite to the reviewer (if asked)

If App Review pushes back, point them at:

- **Roblox** - in-app catalog of user-generated experiences, free
  shell, IAP for currency.
- **Telegram Mini Apps** - in-app catalog of third-party HTML5
  experiences, free.
- **Sonos** - companion app that surfaces third-party services
  inside the shell, free.
- **Philips Hue** - companion app that lists third-party
  integrations.
- **Apple's own Shortcuts Gallery** - user-generated content surfaced
  inside an Apple-built app, with reporting and moderation.

The closest analogue to our positioning is **Sonos / Hue**: a
companion app for a hardware device that the user owns, listing
third-party experiences for that device. This framing is what we
want to win on.

---

## 6. Pre-submission action plan

> **Implementation status (2026-05-29).** This section is the
> *original* plan. For where each item actually stands today, see
> [`APP_STORE_AUDIT_2026-05.md`](./APP_STORE_AUDIT_2026-05.md). In
> short: the four UGC pillars (§ 6.1) shipped, the voice-backend
> credential migration shipped, and the remaining hard blockers are the
> server-side catalog kill switch (§ 6.2.2) and pre-publication
> moderation (§ 6.2.1). Note that the report mechanism shipped
> against **HF Trust & Safety** (a `<spaceUrl>?report=true` deeplink),
> not a Pollen-operated `/api/apps/report` endpoint as § 6.1.1
> originally proposed.

Four chantiers, in priority order. None of them is a research
problem; all of them are concrete code work.

### 6.1 UGC compliance in the mobile shell (Guideline 1.2)

Estimated effort: 1.5 days.

**6.1.1 - Report mechanism**

- Add a kebab menu (or `Info` icon) to every `AppCard` with a
  "Report this app" item.
- Add the same item to the `AppIframeOverlay` top bar.
- On tap: open a modal with a category selector (Spam, Inappropriate
  content, Misleading, Hate / harassment, Privacy concern, Other) and
  a free-text field.
- Submit to a backend endpoint
  (`POST https://pollen-robotics-reachy-mini.hf.space/api/apps/report`)
  with `{ appId, category, text, reporterHash }`.
- The endpoint logs the report and (for known patterns) auto-hides
  the app from the catalog after N reports of the same category.

**6.1.2 - Block / hide author**

- Same kebab menu: "Hide all apps from this author".
- Stored in a local `mmkv`-style preference; the catalog filter
  excludes those authors before rendering.
- This is the **client-side** counterpart of the server-side kill
  switch.

**6.1.3 - EULA / Terms of Service**

- First-launch consent screen with bullet points: third-party content,
  microphone/camera permissions, ability to report and block.
- Full text linked to a public URL.
- Re-prompt on TOS version bump.

**6.1.4 - Contact information**

- A single "Help & support" entry in the app's settings menu, with:
  - Email (`mobile@pollen-robotics.com` or equivalent).
  - Link to the public privacy policy.
  - App version + commit hash for bug reports.

### 6.2 Server-side moderation pipeline

Estimated effort: 3 days for the v1, ongoing for the model tuning.

The catalog filter `reachy_mini_js_app` is currently the **only**
gate. It is self-attributed by Space authors. We need a second gate
between "tagged" and "appears in the mobile catalog".

**6.2.1 - Pre-publication automated check**

When a Space tagged `reachy_mini_js_app` is detected:

- Scan title, description, README, screenshots with a classifier
  (off-the-shelf, e.g. text moderation API or a self-hosted small
  model).
- Scan the rendered iframe URL for known malicious patterns
  (popups, geolocation prompts on first paint, infinite microphone
  request).
- If clean, mark `mobile_visible: true` on the catalog entry.
- If suspicious, mark `mobile_visible: false` and flag for human
  review.

**6.2.2 - Kill switch**

- The catalog endpoint (`/api/js-apps`) must filter on
  `mobile_visible: true` for the **mobile** caller (detect via
  `User-Agent` or a query param `?surface=mobile`).
- Hiding an app is a single Hub mutation, no app update needed. This
  is the kill switch Apple will ask about.

**6.2.3 - Report-driven hiding**

- Reports from 6.1.1 feed back into the same `mobile_visible` flag.
- Threshold-based auto-hide (e.g. ≥3 reports in 24h) plus manual
  review queue.

### 6.3 Bridge documentation

Estimated effort: 0.5 day.

- Document the `postMessage` contract between shell and iframe
  in [`AGENTS.md`](../AGENTS.md) and in this file.
- Document the iframe `allow` list and the rationale for each entry.
- Keep the contract finite: any new message type must be added with
  a security review note.
- This documentation lives in the repo so it can be linked to in
  reviewer responses.

### 6.4 Marketing / strings audit

Estimated effort: 0.5 day.

- Search the source for forbidden terms (`App Store`, `Marketplace`,
  `Download`, `Install`).
- Update App Store metadata, screenshots, in-app strings, onboarding
  copy.
- Use the consistent vocabulary: "Apps for your Reachy Mini",
  "Skills", "Library", "Launch", "Open".
- Decide on a single product name for the catalog surface and use it
  everywhere. Suggested: **"Reachy Apps"** or **"Skills"**.
- Update the Apps tab subtitle from
  `"N apps available"` to
  `"N experiences for your Reachy Mini"` (or similar).

### 6.5 Privacy policy + data safety

Estimated effort: 0.5 day, mostly legal review.

- Public privacy policy URL.
- Apple Privacy Nutrition label populated.
- Google Play Data Safety form populated.
- Both must explicitly mention:
  - HF account information (token, username) used to authenticate
    against Hugging Face.
  - Audio recorded for the conversation feature; not stored on our
    servers; streamed to OpenAI's realtime service by default (or the
    Hugging Face realtime backend if the user opts in via settings).
  - Third-party apps loaded from the catalog operate independently
    and are subject to the privacy policy of their author.

---

## 7. Submission checklist

Before tagging the first App Store / Play Store build:

- [x] In-app sign-in via `ASWebAuthenticationSession` (2.6)
- [ ] Android intent filter for `reachymini` scheme added once
      `gen/android/` is generated (2.6)
- [ ] All four UGC pillars implemented (6.1.1 - 6.1.4)
- [ ] Server-side kill switch live and tested (6.2.2)
- [ ] Pre-publication moderation pipeline live (6.2.1)
- [ ] Reports feed back into the kill switch (6.2.3)
- [ ] `postMessage` contract documented (6.3)
- [ ] Iframe `allow` list reviewed and minimal (6.3)
- [ ] No forbidden marketing terms in source or store metadata (6.4)
- [ ] Privacy policy URL public and current (6.5)
- [ ] Apple Privacy Nutrition label populated (6.5)
- [ ] Google Play Data Safety form populated (6.5)
- [ ] Age rating set to 12+ (or higher if questionnaire pushes us)
- [ ] App Review notes drafted, citing 4.7 explicitly and naming
      Roblox / Telegram / Sonos as precedents
- [ ] Internal red-team pass: try to publish a Space with disallowed
      content and verify the moderation funnel catches it

---

## 8. Open questions

These are explicitly **not** decided yet and need a product call:

1. **Is the catalog gate `mobile_visible: true` controlled by
   Pollen Robotics, by the author themselves, or by both?** The
   Apple-safe answer is "by Pollen", with author-side metadata used
   only as a hint. This adds operational cost.
2. **Do we want age-gated apps?** A 12+ shell with per-app age tags
   would let us surface only age-appropriate apps to younger users.
   Out of scope for v1 unless Apple asks.
3. **Do we expose any iframe → host capability beyond the current
   incoming `hf-token` postMessage?** Every new bridge message is a
   review surface. Resist adding them; if needed, add them through a
   typed schema and document each.
4. **Region restrictions?** Some content may be illegal in some
   jurisdictions even if it passes the global moderation pipeline.
   Out of scope for v1.

---

## 9. References

- [App Store Review Guidelines, section 4.7](https://developer.apple.com/app-store/review/guidelines/#mini-apps-mini-games-streaming-games-chatbots-plug-ins-and-game-emulators)
- [App Store Review Guidelines, section 1.2 (UGC)](https://developer.apple.com/app-store/review/guidelines/#user-generated-content)
- [App Store Review Guidelines, section 2.5.2](https://developer.apple.com/app-store/review/guidelines/#software-requirements)
- [App Store Review Guidelines, section 3.2.2](https://developer.apple.com/app-store/review/guidelines/#unacceptable)
- [Google Play User-Generated Content policy](https://support.google.com/googleplay/android-developer/answer/9876937)
- [Google Play WebView restrictions](https://support.google.com/googleplay/android-developer/answer/13316080)
- Internal: [`AGENTS.md`](../AGENTS.md) (architecture & layer rules)
- Internal: [`README.md`](../README.md) (stack & feature overview)
