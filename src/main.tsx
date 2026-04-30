import { createRoot } from 'react-dom/client';
import { CssBaseline, ThemeProvider, useMediaQuery } from '@mui/material';
import { CacheProvider } from '@emotion/react';
import createCache from '@emotion/cache';
import {
  debug as logDebug,
  error as logError,
  info as logInfo,
  warn as logWarn,
} from '@tauri-apps/plugin-log';

import App from './App';
import { lightTheme, darkTheme } from './theme';

// Single Emotion cache shared by the whole app.
//
// iOS 18.7 WKWebView under `tauri://localhost` (custom URL scheme)
// has a hard bug: every `<style>` element created from JavaScript -
// regardless of where it's appended (head/body), regardless of the
// injection method (`textContent`, `appendChild(textNode)`, even
// `<link rel="stylesheet" href="blob:...">`) - never gets a
// `CSSStyleSheet` attached. `el.sheet` stays `null` forever and the
// rules in the element's text are completely ignored by the styling
// engine. Verified empirically with a sanity probe (see git log;
// `applied: false` for head/body/blob, `applied: true` only for
// Constructable Stylesheets via `document.adoptedStyleSheets`).
//
// The only working escape hatch is the modern Constructable
// Stylesheets API. We keep Emotion in `speedy: false` mode so that
// the text of every rule shows up in `<style data-emotion="…">`
// (with speedy mode the bug also kills `insertRule()`, leaving the
// element empty), and we then mirror each Emotion `<style>`'s
// `textContent` into a real `CSSStyleSheet` adopted by `document`.
// See `installAdoptedStyleSheetsMirror()` below.
const emotionCache = createCache({
  key: 'css',
  speedy: false,
});

// Mirror every `<style data-emotion="…">` Emotion injects into a
// Constructable Stylesheet adopted by `document`. This is the only
// way to get CSS-in-JS rules to actually apply on iOS 18.7 WKWebView
// served from `tauri://localhost` (see Emotion cache comment above).
//
// On every other platform (and in `vite dev` running in regular
// Safari/Chrome) the regular `<style>` injection works fine, so this
// mirror is purely additive: it adds adopted sheets that say the
// same thing as the inert `<style>` elements, no conflict.
function installAdoptedStyleSheetsMirror(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  // Constructable Stylesheets shipped in WebKit 17+ - bail if missing.
  if (typeof window.CSSStyleSheet !== 'function') return;
  const sample = new window.CSSStyleSheet();
  if (typeof sample.replaceSync !== 'function') return;
  const docAny = document as unknown as {
    adoptedStyleSheets: CSSStyleSheet[];
  };
  if (!Array.isArray(docAny.adoptedStyleSheets)) return;

  // Per-style-element bookkeeping: which adopted sheet mirrors it,
  // and the last text length we synced so we can short-circuit.
  const mirrorBySource = new WeakMap<
    HTMLStyleElement,
    { sheet: CSSStyleSheet; len: number }
  >();

  function sync(): void {
    const sources = document.head.querySelectorAll<HTMLStyleElement>(
      'style[data-emotion]',
    );
    const adopted = Array.from(docAny.adoptedStyleSheets);
    let dirty = false;
    sources.forEach((src) => {
      const text = src.textContent ?? '';
      let entry = mirrorBySource.get(src);
      if (!entry) {
        const sheet = new window.CSSStyleSheet();
        entry = { sheet, len: -1 };
        mirrorBySource.set(src, entry);
        adopted.push(sheet);
        dirty = true;
      }
      if (text.length !== entry.len) {
        try {
          entry.sheet.replaceSync(text);
          entry.len = text.length;
        } catch {
          // Emotion can write partial text mid-flush; ignore and
          // pick it up on the next observer tick when it's whole.
        }
      }
    });
    if (dirty) docAny.adoptedStyleSheets = adopted;
  }

  // Observe `<head>` for added `<style>` elements AND for text
  // changes inside existing ones (Emotion in non-speedy mode keeps
  // appending text nodes to the same `<style>`).
  const observer = new MutationObserver(() => sync());
  observer.observe(document.head, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  // Initial pass for whatever's already there at script-load time.
  sync();
}

installAdoptedStyleSheetsMirror();

// Forward `console.*` to the Rust `tauri-plugin-log` pipeline. iOS
// stdout is bit-bucketed and Safari Web Inspector is unreliable on
// Tauri (tauri-apps/tauri#13346), so the only way to actually read
// runtime errors / structured logs from a deployed iPhone build is
// to pipe them through the plugin's invoke channel into the LogDir
// target (configured in `src-tauri/src/lib.rs`), then pull the file
// off the sandbox with
//   `xcrun devicectl device copy from --domain-type appDataContainer
//      --domain-identifier com.tfrere.reachymini.app
//      --source "Library/Application Support/com.tfrere.reachymini.app/logs"`.
//
// We wrap rather than replace the originals so DevTools (when the
// inspector *is* reachable) still shows the message inline.
function stringifyArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}\n${arg.stack ?? ''}`;
  }
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}
function joinArgs(args: unknown[]): string {
  return args.map(stringifyArg).join(' ');
}
const orig = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  debug: console.debug.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};
console.log = (...args: unknown[]) => {
  orig.log(...args);
  void logInfo(joinArgs(args)).catch(() => undefined);
};
console.info = (...args: unknown[]) => {
  orig.info(...args);
  void logInfo(joinArgs(args)).catch(() => undefined);
};
console.debug = (...args: unknown[]) => {
  orig.debug(...args);
  void logDebug(joinArgs(args)).catch(() => undefined);
};
console.warn = (...args: unknown[]) => {
  orig.warn(...args);
  void logWarn(joinArgs(args)).catch(() => undefined);
};
console.error = (...args: unknown[]) => {
  orig.error(...args);
  void logError(joinArgs(args)).catch(() => undefined);
};

// Catch every uncaught error (incl. React render crashes that escape
// any error boundary) and synchronous exceptions, so they show up in
// the Rust log file we pull from the device sandbox. Without this an
// Emotion / theme crash would silently strip the page back to its
// unstyled HTML and leave us no breadcrumb on iOS.
window.addEventListener('error', event => {
  console.error(
    '[uncaught]',
    event.message,
    'at',
    `${event.filename || '<unknown>'}:${event.lineno || 0}:${event.colno || 0}`,
    event.error,
  );
});
window.addEventListener('unhandledrejection', event => {
  console.error('[unhandledrejection]', event.reason);
});

console.info('[boot] main.tsx loaded, console-to-log bridge installed');

function Root() {
  // `prefers-color-scheme` handling: follow the OS with no UI toggle. We
  // intentionally recompute the hook result on every render rather than
  // caching in state - MUI's `useMediaQuery` already listens to changes.
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const theme = prefersDark ? darkTheme : lightTheme;

  return (
    <CacheProvider value={emotionCache}>
      <ThemeProvider theme={theme}>
        <CssBaseline enableColorScheme />
        <App />
      </ThemeProvider>
    </CacheProvider>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root container');

// NOTE: StrictMode disabled on purpose. We tested it on - the lifecycle
// stores (engineLifecyclePromise, setDesiredState, trajectoryGate) absorb
// the double-invokes correctly, but the duplicated effect runs make
// production-like log traces noisy and waste daemon round-trips during
// the BLE handshake (every BLE GATT read fires twice, every WebRTC ICE
// trace prints twice). Re-enable locally if you want to stress-test
// StrictMode-safety; keep it off by default for a calmer dev console.
createRoot(container).render(<Root />);

// One-shot post-mirror sanity check. We've established (see the
// big comment block above the Emotion cache) that on iOS 18.7
// WKWebView under `tauri://localhost`, plain `<style>` injection
// is inert and only Constructable Stylesheets adopted by `document`
// actually style the page. After 250 ms we sample the first MUI
// element to confirm the mirror is doing its job - if its computed
// `display` is `flex` (or whatever the rule says), we're good. If
// it's still `block`, we're back into "broken layout" territory
// and need to look at the mirror's MutationObserver wiring.
window.setTimeout(() => {
  try {
    const docAny = document as unknown as { adoptedStyleSheets?: CSSStyleSheet[] };
    const adoptedCount = Array.isArray(docAny.adoptedStyleSheets)
      ? docAny.adoptedStyleSheets.length
      : null;
    const emotionStyles = document.head.querySelectorAll<HTMLStyleElement>(
      'style[data-emotion]',
    );
    const sampleMui = document.querySelector<HTMLElement>('[class*="Mui"]');
    const sampleSummary = sampleMui
      ? (() => {
          const cs = getComputedStyle(sampleMui);
          return {
            tag: sampleMui.tagName,
            className: sampleMui.className,
            display: cs.display,
            flexDirection: cs.flexDirection,
            fontFamily: cs.fontFamily.slice(0, 40),
          };
        })()
      : null;
    console.info('[css-debug] dom probe', {
      adopted_stylesheets: adoptedCount,
      emotion_styles: emotionStyles.length,
      sample_mui: sampleSummary,
      ua: navigator.userAgent,
    });
    if (sampleSummary && sampleSummary.display === 'block' && adoptedCount === 0) {
      console.error(
        '[css-debug] adopted-stylesheets mirror NOT running — MUI rules will be inert',
      );
    }
  } catch (err) {
    console.error('[css-debug] probe failed', err);
  }
}, 250);
