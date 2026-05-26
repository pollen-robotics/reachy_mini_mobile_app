/**
 * Full-screen iframe overlay used to host an embedded Reachy Mini
 * app inside the mobile shell.
 *
 * Architecture
 * ────────────
 * - The session hook (`useRobotSession`) drives the WebRTC release
 *   when `setOpenedApp(app)` flips the host's state. This component
 *   is therefore mounted DURING the release (`session.phase ===
 *   'releasing'`) and stays mounted through the iframe's life. It
 *   reads the phase to gate its iframe `src`: the embed only dials
 *   out once the phase has reached `released`, so central has had
 *   time to free the producer slot.
 * - On close we just call `onClose()`, which flips the host state
 *   and triggers `session.reacquire()` upstream. The iframe is
 *   unmounted as part of the close.
 *
 * The host owns the handoff lifecycle; this component is dumb-pipe
 * UI on top of it.
 *
 * OAuth handover via postMessage
 * ──────────────────────────────
 * Catalog apps run in `hf_oauth: true` HF Spaces, which means a
 * full OAuth round-trip on first load. That round-trip doesn't
 * work cleanly inside an iframe (the redirect URI is the Space,
 * not our shell, so the user would have to log in again every
 * time even though they already signed in to the mobile app).
 *
 * We bypass that by sending the parent's HF access token via
 * `postMessage` once the iframe lands, mirroring the convention
 * pioneered by the vibe-coder preview iframe: the app stores the
 * token in `window.__REACHY_MINI_PREVIEW_TOKEN__` and uses
 * `robot.connect(token)` to skip OAuth. The vibe-coder injects
 * the token via `srcDoc` + `<script>` (same-origin); we have to
 * use `postMessage` because the app runs cross-origin.
 *
 * Apps that opt in to mobile-shell support add a tiny listener at
 * the top of `main.js`:
 *
 *     window.addEventListener('message', (e) => {
 *       if (e.data?.source === 'reachy-mini-shell' &&
 *           e.data?.kind === 'hf-token' &&
 *           typeof e.data.token === 'string') {
 *         window.__REACHY_MINI_PREVIEW_TOKEN__ = e.data.token;
 *       }
 *     });
 *
 * Apps that don't carry the listener fall through to the regular
 * OAuth flow inside their iframe (and the user signs in again).
 *
 * We send the token in a 3-message burst (immediate / +100ms /
 * +500ms) to handle the race where the iframe's `onLoad` fires
 * before its `main.js` has installed the listener.
 *
 * Theme handover via postMessage
 * ──────────────────────────────
 * The iframe URL carries `?theme=dark|light` at mount time, but
 * that only handles the initial paint. If the user toggles the
 * phone's system theme while the iframe is still open, the shell
 * re-renders (MUI's `useTheme()` reflects the change), and we push
 * the new mode to the iframe via:
 *
 *     { source: 'reachy-mini-shell', kind: 'theme', theme: 'dark'|'light' }
 *
 * Apps that opt-in install a listener mirroring the token one and
 * flip `data-theme` on `<html>`. Apps that don't simply stay on
 * the theme they got from the query param at load - no regression.
 *
 * Embed-config handover via postMessage
 * ─────────────────────────────────────
 * The query string already carries `embedded=1`, which is enough
 * for an app to know it's running inside our shell. We also send
 * an `embed-config` message after `onLoad` so apps can pick up
 * richer host metadata (host identifier, chrome-provided hint)
 * without us having to bloat the URL:
 *
 *     {
 *       source: 'reachy-mini-shell',
 *       kind: 'embed-config',
 *       host: 'reachy-mini-mobile-app',
 *       chrome: 'host-provided',  // we paint a top toolbar + close
 *     }
 *
 * Apps that opt in (e.g. `reachy_mini_telepresence`) read this to
 * suppress their own TopBar / chrome so the user sees a single,
 * coherent toolbar (ours). Apps that ignore the message keep
 * rendering whatever they already rendered - graceful degradation.
 *
 * `host:init` handover via postMessage (protocol v1)
 * ─────────────────────────────────────────────────
 * Apps that consume `connectToHost()` from
 * `@reachy-mini/host/embed` post `embed:ready` once their iframe
 * is alive and then `await` a `host:init` from us before resolving
 * their boot. We reply with a protocol-v1 envelope:
 *
 *     {
 *       source: 'reachy-mini',
 *       type: 'host:init',
 *       version: 1,
 *       theme, signalingUrl, hfToken, userName,
 *       robotPeerId, config, hostName, appName,
 *     }
 *
 * The payload is byte-identical to what we already encoded into
 * the URL hash via `buildEmbedCreds()` - both channels read from
 * the same `EmbedCredsBundle`, so they cannot drift. Without this
 * reply the embed's `awaitHostInit` falls back to its timeout
 * (currently 2 s) before proceeding from the hash alone, adding a
 * pure dead-time stall to every app open. The reply is bursted on
 * the same 3-step schedule (immediate / +100 / +500 ms) as the
 * token / theme / embed-config handovers to absorb the race
 * between our `onLoad` and the embed installing its listener.
 *
 * Apps that don't run `connectToHost()` (e.g. legacy embeds that
 * decode the hash themselves) ignore the message - it's a noop
 * for them.
 */
import {
  Box,
  CircularProgress,
  IconButton,
  Stack,
  Typography,
  useTheme,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  buildAppEmbedUrl,
  buildEmbedCreds,
  type AppEmbedContext,
  type EmbedCredsBundle,
} from '@/features/apps/buildEmbedUrl';
import type { AppEntry } from '@/features/apps/types';
import type { SessionPhase } from '@/features/robot-session/useRobotSession';
import { FONT_WEIGHT, LAYOUT, TYPO } from '@/ui/design/tokens';
import AppActionsMenu from './AppActionsMenu';
import AppIcon from './AppIcon';

/**
 * Hard timeout for the iframe load step (HTML + JS bundle parsed).
 * If the embed hasn't fired `onLoad` within this window we display
 * an error overlay and let the user fall back to the catalog.
 */
const IFRAME_LOAD_TIMEOUT_MS = 15_000;

/**
 * Hard timeout for the embed boot step (`onLoad` fired but the app
 * hasn't reached `phase: 'live'`). Covers `connectToHost()`'s wait
 * for `host:init`, the WebRTC handshake, and the wake-up motion -
 * so it has to be longer than just the iframe load (cold-starting
 * an HF Space + ICE negotiation + initial trajectory all stack up).
 */
const EMBED_CONNECT_TIMEOUT_MS = 20_000;

interface AppIframeOverlayProps {
  app: AppEntry;
  hfToken: string;
  /** HF username, displayed by the embedded app and required by the
   * SDK's `authenticate()` cache check. Pass through whatever
   * `useRemoteHfToken` returned; the URL fragment falls back to a
   * placeholder if it's `null`. */
  hfUsername: string | null;
  robotPeerId: string;
  robotName: string;
  /**
   * Current session phase. Used to gate the iframe `src`: we only
   * navigate the iframe to the embed URL once the host's
   * `releaseForHandoff()` has resolved (`phase === 'released'`).
   * Until then the iframe stays on `about:blank` so the embed's
   * SDK doesn't dial out while our session is still releasing.
   */
  sessionPhase: SessionPhase;
  /** Called by the user (close button or hardware back). The host
   * is responsible for triggering `session.reacquire()` once this
   * fires. */
  onClose: () => void;
}

/**
 * Visible phases of the overlay, from mount to teardown:
 *
 *   waiting-release : we asked the host session to free the WebRTC
 *                     slot; the iframe is still on `about:blank`.
 *   loading         : iframe is dialing the HF Space and parsing
 *                     the bundle. Ends on the iframe's `onLoad`.
 *   connecting      : `onLoad` fired, but the embedded app is
 *                     still inside `connectToHost()` (negotiating
 *                     the session, waking the robot). The embed
 *                     paints almost nothing during that window;
 *                     without this phase the user stares at a
 *                     blank iframe for several seconds.
 *   ready           : the embed posted `embed:app-state` with
 *                     `phase: 'live'`. Overlay disappears, the
 *                     iframe is fully visible.
 *   error           : either timeout or the embed posted a fatal
 *                     `embed:error`. We render the catalog
 *                     fallback view.
 */
type LoadPhase =
  | 'waiting-release'
  | 'loading'
  | 'connecting'
  | 'ready'
  | 'error';

/** Sub-step inside `connecting`, mirroring the protocol's
 *  `AppConnectingStep`. Used to render a more accurate caption
 *  ("Waking the robot…" beats "Loading…" when the user is one
 *  motion away from interacting). */
type ConnectingStep = 'link' | 'session' | 'wake' | null;

export default function AppIframeOverlay({
  app,
  hfToken,
  hfUsername,
  robotPeerId,
  robotName,
  sessionPhase,
  onClose,
}: AppIframeOverlayProps) {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';

  const [loadPhase, setLoadPhase] = useState<LoadPhase>('waiting-release');
  const [connectingStep, setConnectingStep] = useState<ConnectingStep>(null);

  // Promote to `loading` as soon as the session has actually been
  // released. Before that, the embed's `startSession` would race
  // our own `stopSession` and the central would reject one of them.
  useEffect(() => {
    if (loadPhase !== 'waiting-release') return;
    if (sessionPhase === 'released') {
      setLoadPhase('loading');
    }
  }, [sessionPhase, loadPhase]);

  // Single source of truth for the embed context. Both the URL
  // hash (`#creds=`) and the protocol-v1 `host:init` we post on
  // iframe load read from the same `EmbedCredsBundle`, so the two
  // channels can never drift on theme / signaling URL / config.
  const embedCtx: AppEmbedContext = useMemo(
    () => ({
      hfToken,
      hfUsername,
      robotPeerId,
      robotName,
      theme: isDark ? 'dark' : 'light',
      appName: app.name,
    }),
    [hfToken, hfUsername, robotPeerId, robotName, isDark, app.name],
  );

  const credsBundle: EmbedCredsBundle = useMemo(
    () => buildEmbedCreds(embedCtx, app.name),
    [embedCtx, app.name],
  );

  const url: string = useMemo(() => {
    const built = buildAppEmbedUrl(app.id, app.sdk, embedCtx);
    // Dev-only diagnostic: surface the full iframe URL (including the
    // `#hf_token=…` fragment) so the developer can copy-paste it into
    // a desktop browser to inspect the embedded app's console /
    // network without the WebView's cross-origin opacity. The URL
    // carries an HF access token; do NOT enable this in production
    // builds.
    if (import.meta.env.DEV) {
      console.info(
        `[app-iframe] embed URL for ${app.id}\n${built}`,
      );
    }
    return built;
  }, [app.id, app.sdk, embedCtx]);

  // Origin we'll target with `postMessage`. Derived from the
  // already-built embed URL so it stays in sync with the
  // sdk-static / sdk-other fork in `buildAppEmbedUrl`. Using a
  // concrete origin (rather than `'*'`) prevents the token from
  // leaking if a different page somehow takes over the iframe.
  const targetOrigin: string = useMemo(() => {
    try {
      return new URL(url).origin;
    } catch {
      // Defensive: if URL parsing fails, fall back to the wildcard.
      // The iframe never reaches a usable state without a parseable
      // src, so practically this branch never runs.
      return '*';
    }
  }, [url]);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const burstTimersRef = useRef<number[]>([]);

  /**
   * Send the parent's HF access token to the iframe so the embedded
   * app can skip its own OAuth round-trip. See the file-level
   * "OAuth handover via postMessage" comment for the receiving
   * convention; in short, the app sets
   * `window.__REACHY_MINI_PREVIEW_TOKEN__` from the message and
   * passes it to `robot.connect(token)`.
   */
  const sendTokenToIframe = useCallback((): void => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    try {
      win.postMessage(
        {
          source: 'reachy-mini-shell',
          kind: 'hf-token',
          token: hfToken,
        },
        targetOrigin,
      );
    } catch (err) {
      // postMessage can throw on serialization failures or if the
      // iframe was navigated away from a same-origin context. The
      // worst case is the embed falls back to its OAuth flow,
      // which is recoverable, so just log and move on.
      console.warn('[apps] hf-token postMessage failed:', err);
    }
  }, [hfToken, targetOrigin]);

  /**
   * Reply to the embed's `embed:ready` with a protocol-v1
   * `host:init` carrying the same data we already serialised into
   * the URL hash. The embedded `connectToHost()` resolves its
   * `awaitHostInit` synchronously on receipt, so the boot doesn't
   * sit on its `HOST_INIT_TIMEOUT_MS` fallback timer waiting for a
   * message that, before this hook, never came (the mobile shell
   * historically only spoke its own `reachy-mini-shell` protocol).
   *
   * Wire format MUST match `@reachy-mini/host/lib/protocol#HostInitMsg`:
   *   - `source: 'reachy-mini'`
   *   - `type:   'host:init'`
   *   - `version: 1`
   * The embed's `isProtocolMessage()` filter rejects anything else
   * silently, so a typo here would re-introduce the 8s wait without
   * any visible error.
   */
  const sendHostInitToIframe = useCallback((): void => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    try {
      win.postMessage(
        {
          source: 'reachy-mini',
          type: 'host:init',
          version: 1,
          theme: credsBundle.theme,
          signalingUrl: credsBundle.signalingUrl,
          hfToken: credsBundle.hfToken,
          userName: credsBundle.userName,
          robotPeerId: credsBundle.robotPeerId,
          config: credsBundle.config,
          hostName: credsBundle.hostName,
          appName: credsBundle.appName,
        },
        targetOrigin,
      );
    } catch (err) {
      // Failing to send `host:init` is recoverable: the embed
      // falls back through `HOST_INIT_TIMEOUT_MS` to the hash
      // creds, which carry the same payload. Log + move on.
      console.warn('[apps] host:init postMessage failed:', err);
    }
  }, [credsBundle, targetOrigin]);

  /**
   * Tell the iframe it's running inside us so it can suppress its
   * own toolbar / chrome. See the file-level "Embed-config
   * handover via postMessage" comment for the receiving
   * convention. Sent in the same `onLoad` burst as the token + the
   * theme so a slow `message` listener still catches it.
   *
   * The shape is intentionally extensible: today it carries the
   * host identifier and a `chrome: 'host-provided'` hint; future
   * fields (host version, dismissable flag, top-bar offset) can
   * ride on the same payload without touching the URL contract.
   */
  const sendEmbedConfigToIframe = useCallback((): void => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    try {
      win.postMessage(
        {
          source: 'reachy-mini-shell',
          kind: 'embed-config',
          host: 'reachy-mini-mobile-app',
          // We always paint our own top toolbar (emoji + app name
          // + close button), so apps should hide theirs to avoid
          // a stacked-chrome look.
          chrome: 'host-provided',
        },
        targetOrigin,
      );
    } catch (err) {
      // A failed embed-config is purely cosmetic (the embedded
      // app keeps its own chrome), so log and move on.
      console.warn('[apps] embed-config postMessage failed:', err);
    }
  }, [targetOrigin]);

  /**
   * Push the shell's current theme to the iframe so apps that
   * opt-in can flip their palette live when the user toggles the
   * system theme. See the file-level "Theme handover via
   * postMessage" comment for the receiving convention.
   */
  const sendThemeToIframe = useCallback(
    (mode: 'dark' | 'light'): void => {
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      try {
        win.postMessage(
          {
            source: 'reachy-mini-shell',
            kind: 'theme',
            theme: mode,
          },
          targetOrigin,
        );
      } catch (err) {
        // Failing to ship a theme update is purely cosmetic - the
        // iframe stays on whatever palette it had. Log + move on.
        console.warn('[apps] theme postMessage failed:', err);
      }
    },
    [targetOrigin],
  );

  // Propagate runtime theme changes to the iframe (the user toggled
  // the phone's system theme while the iframe was already open).
  // The initial paint is already covered by the `?theme=` query
  // param baked into the URL + the burst sent on iframe `onLoad`,
  // so this effect only matters AFTER the iframe is ready.
  useEffect(() => {
    if (loadPhase !== 'ready') return;
    sendThemeToIframe(isDark ? 'dark' : 'light');
  }, [isDark, loadPhase, sendThemeToIframe]);

  /**
   * Tracks whether the iframe ever posted a protocol-v1 envelope
   * (typically `embed:ready` first, then `embed:app-state`). Used
   * to distinguish modern apps that consume `connectToHost()`
   * (and will eventually post `phase: 'live'`) from legacy
   * hash-only embeds that paint pixels straight after `onLoad`
   * and never speak the protocol. Without this we'd hold the
   * spinner over an already-rendered legacy app for the full
   * `EMBED_CONNECT_TIMEOUT_MS`, which is exactly the UX we're
   * trying to avoid.
   */
  const sawProtocolMsgRef = useRef(false);

  /**
   * Listen to protocol-v1 lifecycle messages from the embed so we
   * can keep the spinner up until the app is actually interactive
   * (`phase: 'live'`). Without this, the iframe reveals a blank
   * page between `onLoad` and the embed's first paint - the
   * exact "did the app crash?" UX we're trying to avoid.
   *
   * Origin filter: the iframe runs on the HF Space subdomain, not
   * on us; we trust messages whose `event.origin` matches the
   * URL we mounted (same `targetOrigin` we already use for our
   * outbound `postMessage` so it can never drift). Anything else
   * is ignored - same defensive posture as the embed bridge.
   */
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== targetOrigin) return;
      const data = event.data as
        | {
            source?: unknown;
            type?: unknown;
            version?: unknown;
            phase?: unknown;
            connectingStep?: unknown;
            fatal?: unknown;
          }
        | null
        | undefined;
      if (!data || typeof data !== 'object') return;
      if (data.source !== 'reachy-mini' || data.version !== 1) return;
      sawProtocolMsgRef.current = true;

      if (data.type === 'embed:app-state') {
        const phase = data.phase;
        const step = data.connectingStep;
        if (phase === 'connecting') {
          setLoadPhase((prev) =>
            prev === 'waiting-release' || prev === 'error' ? prev : 'connecting',
          );
          if (step === 'link' || step === 'session' || step === 'wake') {
            setConnectingStep(step);
          } else {
            setConnectingStep(null);
          }
        } else if (phase === 'live') {
          setLoadPhase('ready');
          setConnectingStep(null);
        } else if (phase === 'error') {
          setLoadPhase('error');
        }
      } else if (data.type === 'embed:error' && data.fatal === true) {
        setLoadPhase('error');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [targetOrigin]);

  /**
   * Legacy fallback: if we entered `connecting` and after a short
   * window the iframe still hasn't posted a single protocol-v1
   * envelope, we conclude it's a hash-only embed that doesn't
   * speak the protocol and reveal it immediately. The spinner
   * was supposed to mask the connectToHost() void; without that
   * void there's nothing to mask. 1.5 s is long enough that a
   * modern app's `embed:ready` always lands first, short enough
   * that legacy apps don't sit behind the overlay long enough to
   * read as broken.
   */
  useEffect(() => {
    if (loadPhase !== 'connecting') return;
    const t = window.setTimeout(() => {
      if (!sawProtocolMsgRef.current) {
        setLoadPhase('ready');
      }
    }, 1500);
    return () => window.clearTimeout(t);
  }, [loadPhase]);

  // Reset the protocol-msg sentinel on every fresh load (the user
  // can close + reopen an app, swapping the iframe `src`). The
  // `url` dep already gates iframe re-navigations.
  useEffect(() => {
    sawProtocolMsgRef.current = false;
  }, [url]);

  // Clean up any pending burst timers on unmount or when the embed
  // URL changes (which would invalidate the iframe contentWindow).
  useEffect(() => {
    return () => {
      for (const id of burstTimersRef.current) window.clearTimeout(id);
      burstTimersRef.current = [];
    };
  }, [url]);

  // Hard timeouts for the two pre-`ready` phases. We split them
  // because they have very different expected durations:
  //   - `loading`    : HF Space cold-start (network + container
  //                    spin-up + bundle parse). 15 s is generous
  //                    for a cold Space, anything past that is a
  //                    real failure cue.
  //   - `connecting` : `connectToHost()` resolving (host:init,
  //                    WebRTC handshake, ensureAwake motion).
  //                    20 s covers slow ICE on phone networks +
  //                    a fresh trajectory player init.
  const timeoutRef = useRef<number | null>(null);
  useEffect(() => {
    if (loadPhase !== 'loading' && loadPhase !== 'connecting') return;
    const budget =
      loadPhase === 'loading' ? IFRAME_LOAD_TIMEOUT_MS : EMBED_CONNECT_TIMEOUT_MS;
    timeoutRef.current = window.setTimeout(() => {
      setLoadPhase('error');
    }, budget);
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [loadPhase]);

  return (
    <Box
      sx={{
        position: 'fixed',
        inset: 0,
        bgcolor: 'background.default',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 1300,
      }}
    >
      {/* Top toolbar.
       *
       * The overlay is `position: fixed; inset: 0`, so it paints
       * INTO the iOS notch / Dynamic Island area. Without an
       * explicit `safe-area-inset-top` padding the status-bar glyphs
       * (carrier, time, battery) overlap the close button + app
       * name and the toolbar reads as broken chrome. We pad the bar
       * by the full inset + the same 8px breathing room we use
       * below it, and let the toolbar's `background.paper` bg
       * paint through the notch so the strip reads as a single
       * continuous band rather than a floating pill below a
       * transparent gap. Same convention as the
       * `RobotSessionScreen` top toolbar.
       */}
      <Stack
        direction="row"
        alignItems="center"
        spacing={1.25}
        sx={{
          px: 2,
          pt: `calc(${LAYOUT.safeAreaTop} + 8px)`,
          pb: 1,
          borderBottom: t => `1px solid ${t.palette.divider}`,
          bgcolor: 'background.paper',
          flexShrink: 0,
        }}
      >
        {/* App glyph on the very left so the user gets the same
            visual identifier they tapped from the apps list - same
            `<AppIcon>` accessor as the apps list tiles. Sized large
            enough to register at a glance but inside the same
            vertical footprint as the title so the bar doesn't grow
            taller. Renders the author's `icon.svg`/`icon.png` when
            available, falls back to the front-matter emoji. */}
        <AppIcon app={app} size={24} />
        {/* App name flush left, primary close button flush right.
            Mirrors native iOS/Android sheet conventions: identifier
            anchors the user, exit affordance is in the thumb-reach
            corner. The primary tint on the close button makes it the
            single visible CTA in the bar so there's no ambiguity
            about how to back out of the embed. */}
        <Typography
          sx={{
            flex: 1,
            minWidth: 0,
            fontSize: TYPO.body,
            fontWeight: FONT_WEIGHT.semibold,
            color: 'text.primary',
          }}
          noWrap
        >
          {app.name}
        </Typography>
        {/* Per-app actions kebab. Apple guideline 1.2 (UGC) wants
            a Report affordance on every surface where the user
            consumes UGC; this is the surface for active use, the
            tile-side counterpart lives in `AppCompactTile`. We
            place the kebab to the left of the close button so the
            primary "exit" action stays in the thumb-reach corner
            (iOS sheet convention) and the kebab is a deliberate
            tap, not the one a user reaching for "Close" hits by
            accident.

            `onAfterHideAuthor` closes this overlay on the spot:
            once the user has hidden the author of the running
            app, leaving them looking at that author's iframe
            would defeat the affordance. Closing also triggers
            the host's `session.reacquire()` upstream so the
            conversation slot comes back. */}
        <AppActionsMenu
          app={app}
          ariaLabel={`Actions for ${app.name}`}
          buttonSx={{ p: 0.5 }}
          onAfterHideAuthor={onClose}
        />
        <IconButton
          aria-label="Close app"
          onClick={onClose}
          edge="end"
          size="small"
          color="primary"
        >
          <CloseIcon />
        </IconButton>
      </Stack>

      <Box sx={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {loadPhase !== 'error' && (
          <iframe
            ref={iframeRef}
            src={loadPhase === 'waiting-release' ? 'about:blank' : url}
            title={app.name}
            // Permissions Policy delegation for the iframe-hosted HF
            // Space. Each capability is explicitly scoped to the
            // iframe's own origin (`'src'`, i.e. the `*.hf.space`
            // subdomain) - explicit `'src'` is preferred over the
            // bare token because behaviour for bare tokens has
            // shifted across Permissions Policy revisions and across
            // engines (WKWebView vs Android WebView vs desktop Chrome).
            //
            // Token rationale:
            //   - microphone  : voice / chat Spaces (`getUserMedia({audio})`)
            //   - camera      : vision / AR Spaces (`getUserMedia({video})`)
            //   - geolocation : tour-guide / location-aware Spaces
            //   - autoplay    : media playback without prior user gesture
            //   - clipboard-* : text / image copy-paste from inside the Space
            //
            // Each token needs a matching OS-side authorisation:
            //   - iOS  : `NSMicrophoneUsageDescription`,
            //            `NSCameraUsageDescription`,
            //            `NSLocationWhenInUseUsageDescription`
            //            in `src-tauri/Info.plist`. Missing the
            //            Camera key while granting the iframe token
            //            HARD-crashes the WKWebView process on
            //            recent iOS - non-optional.
            //   - Android : `RECORD_AUDIO`, `CAMERA`,
            //               `ACCESS_FINE_LOCATION` in the generated
            //               `AndroidManifest.xml`, plus a custom
            //               `WebChromeClient` in `MainActivity.kt`
            //               that maps `onPermissionRequest` and
            //               `onGeolocationPermissionsShowPrompt` to
            //               the OS grants. Tauri's default WebView
            //               denies iframe permission requests
            //               otherwise. Full runbook in
            //               `docs/ANDROID_PERMISSIONS.md`. The
            //               Android target itself isn't initialised
            //               in this repo today; the iframe tokens
            //               are harmless until then.
            allow="microphone 'src'; camera 'src'; geolocation 'src'; autoplay 'src'; clipboard-read 'src'; clipboard-write 'src'"
            onLoad={() => {
              // Iframe done parsing the bundle - move to
              // `connecting`. The overlay stays up; we'll only
              // reveal the iframe once the embed posts
              // `embed:app-state` with `phase: 'live'` (handled
              // by the `message` listener above). Apps that
              // don't run `connectToHost()` (legacy hash-only
              // embeds) never post that event, so for those we
              // rely on the `EMBED_CONNECT_TIMEOUT_MS` failsafe -
              // OR they fall back to user-perceptible iframe
              // content immediately after `onLoad`, which makes
              // the spinner-on-top a non-issue.
              if (loadPhase === 'loading') setLoadPhase('connecting');
              // Burst the protocol-v1 `host:init` first so the
              // embed's `awaitHostInit` resolves immediately
              // instead of falling back through its timeout. Same
              // 3-burst race mitigation (immediate / +100 / +500)
              // we apply to every other handover message: the
              // first send may land before `connectToHost()` has
              // wired its `message` listener.
              sendHostInitToIframe();
              // Burst the HF token over postMessage. The first
              // send may land before the embed's `main.js` has
              // installed its `message` listener (the listener
              // typically runs after the inline `<script
              // type="module">` SDK loader); the +100 / +500 ms
              // re-sends close that race. Apps that aren't
              // listening simply ignore the messages.
              sendTokenToIframe();
              // Same race exists for the theme message. The
              // `?theme=` query param already gave the iframe its
              // initial palette at boot, but we re-assert it here
              // so apps that flip on `data-theme` get the value
              // even if their bootstrap script reads the URL
              // before our theme params resolve.
              const currentTheme: 'dark' | 'light' = isDark ? 'dark' : 'light';
              sendThemeToIframe(currentTheme);
              // Embed-config: same race, same 3-burst mitigation.
              // Apps that opt-in (e.g. telepresence) read this to
              // suppress their own chrome so we don't end up with
              // two stacked toolbars.
              sendEmbedConfigToIframe();
              burstTimersRef.current.push(
                window.setTimeout(sendHostInitToIframe, 100),
                window.setTimeout(sendHostInitToIframe, 500),
                window.setTimeout(sendTokenToIframe, 100),
                window.setTimeout(sendTokenToIframe, 500),
                window.setTimeout(() => sendThemeToIframe(currentTheme), 100),
                window.setTimeout(() => sendThemeToIframe(currentTheme), 500),
                window.setTimeout(sendEmbedConfigToIframe, 100),
                window.setTimeout(sendEmbedConfigToIframe, 500),
              );
            }}
            style={{
              width: '100%',
              height: '100%',
              border: 'none',
              display: 'block',
              colorScheme: isDark ? 'dark' : 'light',
              backgroundColor: theme.palette.background.default,
            }}
          />
        )}

        {(loadPhase === 'waiting-release' ||
          loadPhase === 'loading' ||
          loadPhase === 'connecting') && (
          <PhaseOverlay>
            <CircularProgress size={28} />
            <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary' }}>
              {phaseCaption(loadPhase, connectingStep, app.name)}
            </Typography>
          </PhaseOverlay>
        )}

        {loadPhase === 'error' && (
          <PhaseOverlay>
            <Typography sx={{ fontSize: TYPO.body, fontWeight: FONT_WEIGHT.medium }}>
              {app.name} didn't load
            </Typography>
            <Typography
              sx={{
                fontSize: TYPO.xs,
                color: 'text.secondary',
                textAlign: 'center',
                maxWidth: 320,
              }}
            >
              The app's Hugging Face Space may be cold-starting or temporarily
              unavailable. Close this view and try again in a moment.
            </Typography>
          </PhaseOverlay>
        )}
      </Box>
    </Box>
  );
}

/**
 * Caption shown next to the spinner. The phases map to user-
 * legible language (avoid "connecting step: link" - what does
 * "link" even mean to the user?). The connecting sub-steps come
 * straight from the protocol's `AppConnectingStep`:
 *   - link    : `host:init` exchanged, SDK calling connect()
 *   - session : startSession() in flight (WebRTC handshake)
 *   - wake    : ensureAwake() in flight (motors moving to neutral)
 */
function phaseCaption(
  phase: Exclude<LoadPhase, 'ready' | 'error'>,
  step: ConnectingStep,
  appName: string,
): string {
  if (phase === 'waiting-release') {
    return 'Releasing the conversation session…';
  }
  if (phase === 'loading') {
    return `Loading ${appName}…`;
  }
  switch (step) {
    case 'link':
      return `Connecting ${appName} to the robot…`;
    case 'session':
      return 'Starting the video session…';
    case 'wake':
      return 'Waking the robot…';
    default:
      return `Starting ${appName}…`;
  }
}

function PhaseOverlay({ children }: { children: React.ReactNode }) {
  return (
    <Box
      sx={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1.5,
        bgcolor: 'background.default',
      }}
    >
      {children}
    </Box>
  );
}
