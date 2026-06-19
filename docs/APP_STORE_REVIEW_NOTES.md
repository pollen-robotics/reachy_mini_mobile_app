# App Store review notes - Reachy Mini

> Paste the "For App Review" section below into App Store Connect ->
> App Review Information -> Notes. Fill in the demo account password
> and confirm the robot is online before submitting. The rest of this
> file is internal context for whoever prepares the submission.

---

## For App Review (copy/paste)

**What the app is**

Reachy Mini is the companion app for the Reachy Mini desk robot
(open-source hardware by Pollen Robotics / Hugging Face). It lets the
owner sign in with their Hugging Face account, connect to their robot
over the network, hold a voice conversation with it, and launch small
web "apps" (interactive experiences) that run on the robot.

**IMPORTANT - the app needs a robot to be fully exercised, and we have
provisioned one for you**

Core features (voice conversation, head control, the Apps tab) require
a Reachy Mini robot that is powered on and registered on our Hugging
Face signaling service. We have provisioned a dedicated robot for this
review and left it online. To exercise the full app:

- Demo Hugging Face account:
  - Username: `<DEMO_HF_USERNAME>`
  - Password: `<DEMO_HF_PASSWORD>`
- A Reachy Mini robot is already paired to this account and kept
  online for the duration of the review. After signing in, it appears
  on the home screen as an available robot - tap it to connect.

If the robot ever shows as offline, please contact us at
support@pollen-robotics.com and we will bring it back online promptly.

**Step-by-step**

1. Launch the app, accept the first-launch consent screen.
2. Sign in with the demo Hugging Face account above (the sign-in runs
   in-app via `ASWebAuthenticationSession`).
3. On the home screen, tap the listed robot to connect.
4. Tap the microphone / conversation control and speak - the robot
   replies with voice.
5. Open the "Apps" tab to browse and launch third-party experiences
   (these run inside a sandboxed web view).

**Guideline 4.7 (mini-apps / plug-ins)**

The "Apps" tab lists small HTML/JavaScript experiences hosted on
Hugging Face Spaces. They are displayed inside a cross-origin web view
iframe. No native code, bytecode, or WASM is downloaded or executed -
each experience is ordinary sandboxed web content, comparable to the
mini-app model used by Roblox, Telegram Mini Apps, Sonos, and Philips
Hue. The only communication from the host app into the iframe is a
small, fixed set of `postMessage` messages (HF token handover, theme,
embed config, and an SDK init payload); the host consumes no inbound
messages from the iframe.

**Guideline 1.2 (user-generated content)**

The catalog of third-party apps is moderated and gated:

- *Filter before it appears (fail-closed):* a Space only appears in
  the mobile catalog after it has been explicitly cleared by our
  automated moderation pipeline (a regex prescreen for unambiguous
  abuse, then an LLM classifier against a closed policy taxonomy:
  sexual, hate, violence, illegal, scam/malware, self-harm). Anything
  classified as a violation, anything the classifier is unsure about,
  and anything not yet moderated stays HIDDEN. A brand-new Space never
  appears before it has been cleared.
- *Kill switch:* we can remove any app server-side immediately via a
  block list, without shipping an app update.
- *Report:* every app has a "Report this app" action that routes to
  Hugging Face Trust & Safety (the platform that hosts the content).
- *Block:* users can hide all apps from a given author, revocable from
  Help & Support.
- *Contact:* Help & Support exposes support@pollen-robotics.com plus
  our Privacy Policy and Terms.

Moderation enforcement is operated by Pollen Robotics; content takedown
and trust & safety on the underlying Hugging Face Spaces is handled by
Hugging Face Trust & Safety.

**Privacy / data flow (Guideline 5.1)**

- Voice: while a conversation is active, microphone audio is streamed
  to Hugging Face's realtime service to generate the robot's replies.
  Audio is not stored on Pollen servers. The app does not bundle any
  long-lived model-provider key: the realtime session is allocated
  server-side, gated by the user's Hugging Face token.
- Account: the Hugging Face access token and username are stored on
  the device and used to authenticate against the Hugging Face Hub.
- No third-party analytics/tracking SDKs; no App Tracking Transparency
  prompt (the app does not track users across apps/websites).

**Permission usage**

- Microphone: voice conversation, and web apps that capture audio.
- Camera: web apps that use the camera (vision/AR demos). The host app
  itself does not capture video.
- Local network: the app talks to the robot's local daemon over HTTP
  on the local network (port 8000).
- Background audio (`UIBackgroundModes = audio`): keeps the WebRTC
  voice session alive if the user locks the screen or backgrounds the
  app mid-conversation, so an in-progress conversation isn't dropped.
  Mirrors the entitlement used by Discord / Slack call panels / Google
  Assistant.

**Sign in with Apple (Guideline 4.8)**

The app is a client for the user's existing Hugging Face account and
their Hugging Face-hosted robot/content; it requires signing in to
that specific third-party service directly. There is no separate
Pollen-operated account system, so Sign in with Apple does not apply.

**Export compliance**

`ITSAppUsesNonExemptEncryption = NO` - the app only uses standard
HTTPS/TLS (Hugging Face, HF realtime, WebRTC), which is exempt.

**Contact:** support@pollen-robotics.com

---

## Internal pre-submission checklist (do not paste)

- [ ] Fill `<DEMO_HF_USERNAME>` / `<DEMO_HF_PASSWORD>` above with the
      real demo account.
- [ ] Confirm the demo account's robot is online on
      `pollen-robotics-reachy-mini-central` during the review window.
- [ ] Privacy Nutrition Label populated (audio -> Hugging Face; HF token +
      username; robot/peer identifiers; no tracking).
- [ ] Age rating questionnaire: answer yes to UGC + unrestricted web
      access -> expect 12+.
- [ ] Privacy Policy URL reachable and covers: HF token/username, audio
      to Hugging Face (not stored on Pollen servers), third-party Spaces
      operating under their own policies, in-app Report/Block.
- [ ] Confirm Apple Developer team `4KLHP7L6KP` is the Pollen Robotics
      organisation account (required for public distribution).
- [ ] Verify the moderation backend has `HF_TOKEN` set in production
      (without it the fail-closed catalog hides all non-official apps).
