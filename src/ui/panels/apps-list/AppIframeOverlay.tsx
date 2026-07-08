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
 * - On close the user's tap on `×` doesn't call `onClose()`
 *   immediately. We first flip into a 1 s "closing" beat that
 *   paints a `Closing ${app.name}…` spinner on top of the iframe
 *   (locks the close button, ignores follow-up activity messages
 *   from the embed). Once the beat ends we call `onClose()`, the
 *   host flips its state, `session.reacquire()` runs upstream,
 *   and the iframe is unmounted. The intermediate beat absorbs
 *   the reacquire latency so the user doesn't see a jarring
 *   mid-frame disappearance.
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
import { Box, CircularProgress, IconButton, Stack, Typography, useTheme } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { appCacheDir, join } from '@tauri-apps/api/path';
import { writeFile } from '@tauri-apps/plugin-fs';
import { shareFile } from '@choochmeque/tauri-plugin-sharekit-api';

import {
  buildAppEmbedUrl,
  buildEmbedCreds,
  type AppEmbedContext,
  type EmbedCredsBundle,
} from '@/features/apps/buildEmbedUrl';
import type { AppEntry } from '@/features/apps/types';
import { APPS_QUERY_KEY, type CatalogPayload } from '@/features/apps/useApps';
import { APP_HANDOFF_TIMINGS } from '@/features/robot-session/timings';
import type { SessionPhase } from '@/features/robot-session/useRobotSession';
import { FONT_WEIGHT, LAYOUT, TYPO } from '@/ui/design/tokens';
import IdentityChipBar from '@/ui/widgets/IdentityChipBar';
import AppActionsMenu from './AppActionsMenu';
import AppIcon from './AppIcon';

/**
 * Timeouts come from the centralised `APP_HANDOFF_TIMINGS` (see
 * `features/robot-session/timings.ts` for the full rationale +
 * audit). Aliased locally so the call sites below stay terse.
 */
const IFRAME_LOAD_TIMEOUT_MS = APP_HANDOFF_TIMINGS.iframeLoadTimeoutMs;
const EMBED_CONNECT_TIMEOUT_MS = APP_HANDOFF_TIMINGS.embedConnectTimeoutMs;

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
  /** Physical transport string from the robot's central listing
   *  (`wifi` / `usb` / …). Forwarded to `<IdentityChipBar>` so the
   *  topbar shows the same stable `Lite` / `Wireless` tag as the
   *  session screen. */
  transport: string;
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
type LoadPhase = 'waiting-release' | 'loading' | 'connecting' | 'ready' | 'error';

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
  transport,
  sessionPhase,
  onClose,
}: AppIframeOverlayProps) {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const queryClient = useQueryClient();

  const [loadPhase, setLoadPhase] = useState<LoadPhase>('waiting-release');
  const [connectingStep, setConnectingStep] = useState<ConnectingStep>(null);
  // Live RTT (ms) reported by the embed itself via `embed:app-state`.
  // The host has released its WebRTC slot to the iframe, so this is
  // the ONLY true measure of the app↔robot link latency. `null` until
  // the embed reports one (older apps never do → pill stays hidden).
  const [embedRttMs, setEmbedRttMs] = useState<number | null>(null);

  /**
   * Effective app entry used to build the iframe URL and label
   * the toolbar. Starts as the caller-supplied snapshot (which is
   * what the user clicked from the apps list, possibly from a
   * stale catalog cache: `useApps()` ships with `staleTime:
   * Infinity` so a same-session catalog refetch only happens via
   * the explicit "refresh" button or the self-healing path below).
   *
   * Self-healing path: on a load failure (timeout, embed error)
   * we invalidate + refetch the catalog once and look up the
   * fresh entry for this `app.id`. If the catalog now reports a
   * different SDK (e.g. an upstream Space was just migrated from
   * `sdk: docker` to `sdk: static`, flipping the subdomain
   * pattern from `<slug>.hf.space` to `<slug>.static.hf.space`),
   * we swap `effectiveApp` to the fresh copy and reset the load
   * phase so the iframe retries against the correct URL. The
   * user sees a fleeting "didn't load" frame followed by a
   * successful boot instead of a permanent error.
   *
   * Rename / deletion: if the fresh catalog no longer carries an
   * entry for `app.id`, we leave the error UI up - we have no
   * server-side alias map to follow the rename, and a renamed
   * Space's old slug 404s the same as a deleted one. The catalog
   * has been refreshed in-place though, so the apps list behind
   * the overlay will show the new state as soon as the user
   * closes us.
   */
  const [effectiveApp, setEffectiveApp] = useState<AppEntry>(app);
  const recoveryAttemptedRef = useRef(false);

  // "Closing" beat. Sits orthogonal to `loadPhase` because the
  // user can request a close from any phase (waiting-release,
  // loading, connecting, ready, error). Once flipped, the
  // PhaseOverlay below paints a `Closing ${appName}…` spinner on
  // top of everything else, and a 1 s timer drives `onClose()` so
  // the parent can unmount us. The intermediate beat avoids the
  // jarring "press × → screen vanishes mid-frame" effect that
  // makes the shell feel like it crashed; it also gives the user
  // a moment to register that their tap registered.
  //
  // Why 1000 ms and not a tighter window: the upstream
  // `session.reacquire()` (kicked off by the host once we
  // unmount) usually takes ~300-800 ms before the conversation
  // surface is paintable again, so a 1 s closing beat overlaps
  // with that reacquire latency rather than tacking onto it.
  const [isClosing, setIsClosing] = useState(false);
  const closeTimerRef = useRef<number | null>(null);

  const requestClose = useCallback(() => {
    // Idempotent: double-tapping the close button (or hitting it
    // while the actions menu's onAfterHideAuthor also fires)
    // should not stack timers or shorten the beat.
    if (isClosing) return;
    setIsClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      onClose();
    }, APP_HANDOFF_TIMINGS.closingBeatMs);
  }, [isClosing, onClose]);

  // Clear the pending teardown if we unmount for any other reason
  // (parent decides to drop us, hot-reload, etc.) so we don't fire
  // `onClose()` against a stale parent.
  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, []);

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
  //
  // Reads from `effectiveApp` (not the prop) so the URL we mount
  // and the metadata we ship over postMessage both follow the
  // self-healing swap when the catalog reports a fresher SDK for
  // this id.
  const embedCtx: AppEmbedContext = useMemo(
    () => ({
      hfToken,
      hfUsername,
      robotPeerId,
      robotName,
      theme: isDark ? 'dark' : 'light',
      appName: effectiveApp.name,
    }),
    [hfToken, hfUsername, robotPeerId, robotName, isDark, effectiveApp.name]
  );

  const credsBundle: EmbedCredsBundle = useMemo(
    () => buildEmbedCreds(embedCtx, effectiveApp.name),
    [embedCtx, effectiveApp.name]
  );

  const url: string = useMemo(() => {
    const built = buildAppEmbedUrl(effectiveApp.id, effectiveApp.sdk, embedCtx);
    // Dev-only diagnostic: surface the full iframe URL (including the
    // `#hf_token=…` fragment) so the developer can copy-paste it into
    // a desktop browser to inspect the embedded app's console /
    // network without the WebView's cross-origin opacity. The URL
    // carries an HF access token; do NOT enable this in production
    // builds.
    if (import.meta.env.DEV) {
      console.info(`[app-iframe] embed URL for ${effectiveApp.id}\n${built}`);
    }
    return built;
  }, [effectiveApp.id, effectiveApp.sdk, embedCtx]);

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
        targetOrigin
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
        targetOrigin
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
        targetOrigin
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
          targetOrigin
        );
      } catch (err) {
        // Failing to ship a theme update is purely cosmetic - the
        // iframe stays on whatever palette it had. Log + move on.
        console.warn('[apps] theme postMessage failed:', err);
      }
    },
    [targetOrigin]
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
            rttMs?: unknown;
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
        // Live link latency the embed measures on its own WebRTC pair
        // (additive protocol field). Update whenever present so the
        // topbar's latency pill tracks the real app↔robot RTT.
        if (typeof data.rttMs === 'number' && Number.isFinite(data.rttMs)) {
          setEmbedRttMs(data.rttMs);
        }
        if (phase === 'connecting') {
          setLoadPhase(prev =>
            prev === 'waiting-release' || prev === 'error' ? prev : 'connecting'
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
   * Native save/share bridge for embedded apps (Android path).
   *
   * `navigator.share({ files })` works in iOS WKWebView - we delegate
   * `web-share 'src'` on the iframe `allow` list - but the Android
   * System WebView ships no Web Share API at all (`navigator.share`
   * is `undefined`). So an app that needs to get a file off the phone
   * (e.g. the cameraman Space's clip export) feature-detects and, on
   * Android, posts the raw bytes out to us instead:
   *
   *     window.top.postMessage(
   *       { source: 'reachy-cameraman', type: 'save-file',
   *         name, mime, bytes: ArrayBuffer },
   *       '*',
   *     );
   *
   * `sharekit` shares a `file://` *path*, not bytes, so we stage the
   * payload in the app cache (`fs`) and open the native share sheet on
   * it. Fire-and-forget: the embed shows no ack today, so a failure
   * here is logged, not surfaced back across the frame.
   *
   * Origin is the trust anchor (same `targetOrigin` as every other
   * handover); we accept whatever `source` the embed declares. This is
   * a separate listener rather than a branch in the protocol-v1
   * `onMessage` above, which hard-filters `source === 'reachy-mini'`
   * and would drop the app's own envelope.
   */
  useEffect(() => {
    const onSaveFile = (event: MessageEvent): void => {
      if (event.origin !== targetOrigin) return;
      const data = event.data as
        | { type?: unknown; name?: unknown; mime?: unknown; bytes?: unknown }
        | null
        | undefined;
      if (!data || data.type !== 'save-file') return;
      if (!(data.bytes instanceof ArrayBuffer)) return;

      // The name crosses an origin boundary and becomes a filesystem
      // path, so strip anything that isn't a plain name - blocks `../`
      // traversal and absolute paths.
      const name = String(data.name ?? 'clip').replace(/[^\w.-]/g, '_') || 'clip';
      const mime =
        typeof data.mime === 'string' && data.mime ? data.mime : 'application/octet-stream';
      const bytes = new Uint8Array(data.bytes);

      void (async () => {
        try {
          const path = await join(await appCacheDir(), name);
          await writeFile(path, bytes);
          await shareFile(`file://${path}`, { mimeType: mime, title: name });
        } catch (err) {
          console.warn('[apps] save-file bridge failed:', err);
        }
      })();
    };
    window.addEventListener('message', onSaveFile);
    return () => window.removeEventListener('message', onSaveFile);
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
    }, APP_HANDOFF_TIMINGS.legacyEmbedRevealMs);
    return () => window.clearTimeout(t);
  }, [loadPhase]);

  // Reset the protocol-msg sentinel on every fresh load (the user
  // can close + reopen an app, swapping the iframe `src`). The
  // `url` dep already gates iframe re-navigations.
  useEffect(() => {
    sawProtocolMsgRef.current = false;
    setEmbedRttMs(null);
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
    const budget = loadPhase === 'loading' ? IFRAME_LOAD_TIMEOUT_MS : EMBED_CONNECT_TIMEOUT_MS;
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

  /**
   * Self-healing on a failed embed load.
   *
   * The catalog hook (`useApps`) ships with `staleTime: Infinity`
   * so once a session has fetched it, the cache is treated as
   * fresh for the rest of the JS session. That's a deliberate
   * cost optimisation - the catalog rarely changes within a
   * session - but it has a sharp edge: when an app's upstream
   * Space changes its SDK (e.g. a `sdk: docker` Space migrated
   * to `sdk: static`), the runtime subdomain flips from
   * `<slug>.hf.space` to `<slug>.static.hf.space` and every
   * client still holding the stale catalog points its iframe at
   * a 404. Until a cold restart or an explicit "refresh" tap,
   * the user just sees "didn't load" on every retry.
   *
   * This effect closes that loop: the FIRST time we land in the
   * `error` phase for this mount, we
   *
   *   1. invalidate the `useApps` cache so its observers see
   *      the new data on next render,
   *   2. force a `refetchQueries` against the catalog so we
   *      don't depend on an observer being currently mounted,
   *   3. look up the fresh entry for `effectiveApp.id`,
   *   4. if the catalog now disagrees on `sdk` (the only field
   *      that changes the iframe URL), swap `effectiveApp` to
   *      the fresh copy and reset the load phase. The `url`
   *      memo recomputes off `effectiveApp.sdk`, the iframe
   *      navigates to the new src, and we re-enter the loading
   *      pipeline cleanly.
   *
   * Guarded by `recoveryAttemptedRef` so a flapping iframe
   * (e.g. a Space that's genuinely 5xx-ing) can't loop on this
   * branch and DoS the catalog endpoint. One try per mount; if
   * the retry also fails, the regular error UI sticks. The user
   * gets the catalog refresh either way, so closing + reopening
   * the apps list always reflects current state.
   *
   * Rename / deletion is not auto-recoverable here (no
   * alias map on the catalog yet), but the refetch we trigger
   * still updates the cache so the apps tab shows reality on
   * its next render.
   */
  useEffect(() => {
    if (loadPhase !== 'error') return;
    if (recoveryAttemptedRef.current) return;
    recoveryAttemptedRef.current = true;

    let cancelled = false;
    void (async () => {
      try {
        await queryClient.refetchQueries({ queryKey: APPS_QUERY_KEY });
        if (cancelled) return;
        const data = queryClient.getQueryData<CatalogPayload>(APPS_QUERY_KEY);
        const fresh = data?.apps.find(a => a.id === effectiveApp.id);
        if (!fresh) return;
        if (fresh.sdk === effectiveApp.sdk) return;
        // Catalog disagrees with what we tried - the snapshot we
        // mounted with was stale. Re-arm the load against the
        // fresh entry. We restart at `loading` because we already
        // saw `released` (the only way to reach `error` from
        // here), and we reset `connectingStep` so the spinner
        // caption doesn't carry over from the previous attempt.
        if (import.meta.env.DEV) {
          console.info(
            `[app-iframe] recovery: catalog now reports sdk=${fresh.sdk} ` +
              `for ${effectiveApp.id} (was ${effectiveApp.sdk}), retrying`
          );
        }
        setEffectiveApp(fresh);
        setConnectingStep(null);
        setLoadPhase('loading');
      } catch (err) {
        console.warn('[apps] catalog refresh during embed-error recovery failed:', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadPhase, queryClient, effectiveApp.id, effectiveApp.sdk]);

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
        spacing={1.5}
        sx={{
          alignItems: 'center',
          px: 2,
          pt: `calc(${LAYOUT.safeAreaTop} + 10px)`,
          pb: 1.5,
          minHeight: 68,
          borderBottom: t => `1px solid ${t.palette.divider}`,
          // Match the host session topbar (`RobotSessionScreen`):
          // same `background.default` fill, height and safe-area
          // padding so launching an app reads as the SAME chrome
          // staying in place rather than a separate sheet popping
          // over it.
          bgcolor: 'background.default',
          flexShrink: 0,
        }}
      >
        {/* App glyph on the very left, vertically spanning the two
            stacked identity lines (robot name over app name) so the
            illustration anchors the whole block - same `<AppIcon>`
            accessor as the apps list tiles. Renders the author's
            `icon.svg`/`icon.png` when available, falls back to the
            front-matter emoji. */}
        <AppIcon app={effectiveApp} size={28} imageSize={36} />
        {/* Stacked identity: the running APP's name is the headline
            (it's what the user is focused on), with the host robot's
            name + transport/latency pills as a secondary context line
            underneath (the same `<IdentityChipBar>` the session topbar
            renders, in its compact `secondary` variant). This keeps the
            user oriented on which robot they're driving without
            competing with the app title. */}
        <Stack sx={{ flex: 1, minWidth: 0, gap: 0.25 }}>
          <Typography
            sx={{
              minWidth: 0,
              fontSize: TYPO.lg,
              fontWeight: FONT_WEIGHT.bold,
              color: 'text.primary',
              letterSpacing: '-0.1px',
              lineHeight: 1.2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            noWrap
          >
            {effectiveApp.name}
          </Typography>
          <IdentityChipBar
            robotName={robotName}
            transport={transport}
            // Host's live WebRTC classification is gone (slot released
            // to the iframe); the bars are driven by the embed-reported
            // RTT below, so the kind fallback is irrelevant here.
            linkKind={null}
            // The host released its WebRTC slot to the iframe, so its
            // own RTT is stale. We instead show the latency the EMBED
            // measures on its live pair and reports via
            // `embed:app-state` - a true app↔robot link read. Until
            // the embed reports one (older apps never do), we hide the
            // pill rather than paint a frozen host value. The stable
            // Lite/Wireless transport tag always shows (identity).
            linkRttMs={embedRttMs}
            sessionPhase={sessionPhase}
            showLatency={embedRttMs !== null}
            variant="secondary"
          />
        </Stack>
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
          app={effectiveApp}
          ariaLabel={`Actions for ${effectiveApp.name}`}
          buttonSx={{ p: 0.5 }}
          onAfterHideAuthor={requestClose}
        />
        <IconButton
          aria-label="Close app"
          onClick={requestClose}
          // While the closing beat is running the button is a
          // visual no-op (the timer is already scheduled), but we
          // disable it explicitly so accessibility tooling
          // doesn't announce it as actionable and so a tap doesn't
          // produce a phantom ripple after the spinner has taken
          // over.
          disabled={isClosing}
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
            title={effectiveApp.name}
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
            //   - autoplay    : media playback without prior user gesture
            //   - clipboard-* : text / image copy-paste from inside the Space
            //   - gamepad     : `navigator.getGamepads()` (telepresence
            //                   head-steering via a paired controller).
            //                   Without this token the Gamepad API returns
            //                   an empty list inside the iframe even when a
            //                   controller is paired to the phone.
            //   - web-share   : `navigator.share({ files })` (clip export); not delegated to cross-origin iframes by default. iOS-solid, Android version-dependent.
            //
            // Each token needs a matching OS-side authorisation:
            //   - iOS  : `NSMicrophoneUsageDescription` and
            //            `NSCameraUsageDescription` in
            //            `src-tauri/Info.plist`. Missing the Camera
            //            key while granting the iframe token
            //            HARD-crashes the WKWebView process on
            //            recent iOS - non-optional.
            //   - Android : `RECORD_AUDIO`, `CAMERA` in the generated
            //               `AndroidManifest.xml`, plus a custom
            //               `WebChromeClient` in `MainActivity.kt`
            //               that maps `onPermissionRequest` to the
            //               OS grants. Tauri's default WebView denies
            //               iframe permission requests otherwise.
            //               Full runbook in `docs/ANDROID_PERMISSIONS.md`.
            //
            // Geolocation is intentionally NOT delegated: no Space
            // surfaces a location feature today and the extra prompt
            // string (`NSLocationWhenInUseUsageDescription`,
            // `ACCESS_FINE_LOCATION`) is an App Review red flag for a
            // capability we don't actually use. Re-add when a Space
            // genuinely needs `navigator.geolocation`.
            allow="microphone 'src'; camera 'src'; autoplay 'src'; clipboard-read 'src'; clipboard-write 'src'; gamepad 'src'; web-share 'src'"
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
                window.setTimeout(sendEmbedConfigToIframe, 500)
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

        {/* Closing beat takes precedence over every other
            PhaseOverlay branch below: once the user has asked to
            close, we want them looking at a single, stable
            "Closing ${app.name}…" spinner — not an error screen,
            not a stale "Loading" caption, not a flash of the
            iframe. The 1 s timer kicked off by `requestClose` is
            already running; this overlay just provides the
            visual placeholder until the parent unmounts us. */}
        {isClosing && (
          <PhaseOverlay>
            <CircularProgress size={28} />
            <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary' }}>
              {`Closing ${effectiveApp.name}…`}
            </Typography>
          </PhaseOverlay>
        )}

        {!isClosing &&
          (loadPhase === 'waiting-release' ||
            loadPhase === 'loading' ||
            loadPhase === 'connecting') && (
          <PhaseOverlay>
            <CircularProgress size={28} />
            <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary' }}>
              {phaseCaption(loadPhase, connectingStep, effectiveApp.name)}
            </Typography>
          </PhaseOverlay>
        )}

        {!isClosing && loadPhase === 'error' && (
          <PhaseOverlay>
            <Typography sx={{ fontSize: TYPO.body, fontWeight: FONT_WEIGHT.medium }}>
              {effectiveApp.name} didn't load
            </Typography>
            <Typography
              sx={{
                fontSize: TYPO.xs,
                color: 'text.secondary',
                textAlign: 'center',
                maxWidth: 320,
              }}
            >
              The app's Hugging Face Space may be cold-starting or temporarily unavailable. Close
              this view and try again in a moment.
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
  appName: string
): string {
  // `waiting-release` (host freeing the WebRTC slot) and
  // `loading` (iframe dialing the Space) are internal beats the
  // user shouldn't have to reason about; from their POV they
  // both belong to the same "the app I just tapped is starting
  // up" moment, so we paint the same `Loading ${appName}…`
  // caption across the pair.
  if (phase === 'waiting-release' || phase === 'loading') {
    return `Loading ${appName}…`;
  }
  switch (step) {
    case 'link':
      return `Connecting ${appName} to the robot…`;
    case 'session':
      return 'Starting the session…';
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
