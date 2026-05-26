/**
 * Top-level error boundary.
 *
 * Mounted above `<App />` in `main.tsx`. Catches anything React
 * itself throws during render or commit (component code, effects'
 * synchronous parts, lifecycle methods). Note that this does NOT
 * catch:
 *   - Errors inside event handlers (those bubble up to `window.onerror`).
 *   - Async errors / unhandled promise rejections (those go to
 *     `window.onunhandledrejection`).
 *   - Errors thrown by the conversation engine outside the React
 *     tree (the engine has its own error reporting via
 *     `onErrorMessageChange`).
 *
 * Without this boundary, a component throw would unmount the
 * whole tree and leave the user staring at a blank Tauri WebView -
 * harder to recover from than a "Something went wrong" screen
 * with a reload button.
 *
 * The fallback UI is intentionally framework-light (no MUI) so
 * it still renders if the failure was inside MUI itself or its
 * theme provider. Inline styles keep us free of the shared
 * stylesheet too.
 */
import {
  Component,
  type ErrorInfo,
  type ReactNode,
} from 'react';

/**
 * Mirror of `features/theme-preference/storage.ts`.
 *
 * `ui/design/` is an atomic-primitives layer that cannot import
 * from `features/` (enforced by `no-restricted-imports`), and
 * the boundary deliberately lives outside the `ThemeProvider` so
 * a failure inside MUI itself still has a fallback to render. We
 * therefore read the same localStorage slot the store writes to,
 * with a defensive set of allowed values so a corrupted cell
 * never crashes the fallback. Keep this in sync with the
 * feature's `THEME_MODE_KEY` and `ThemeMode` union if either
 * changes.
 */
const THEME_MODE_KEY = 'reachyMini.themeMode';
type SavedMode = 'system' | 'light' | 'dark';

function readSavedMode(): SavedMode {
  try {
    if (typeof localStorage === 'undefined') return 'system';
    const raw = localStorage.getItem(THEME_MODE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    // Private mode / quota / blocked storage. Fall through to
    // the system default - the boundary is a best-effort surface
    // and we never want to compound the original failure.
  }
  return 'system';
}

interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Optional callback fired with the captured error and the
   * component stack. Useful to forward the report to a logger /
   * crash reporter (Sentry, custom telemetry, …) once such a
   * pipeline exists.
   */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Always log so the failure shows up in the Tauri devtools
    // console even when no `onError` consumer is wired.
    console.error('[error-boundary] caught render error:', error, info);
    this.props.onError?.(error, info);
  }

  private readonly handleReload = (): void => {
    // Hard reload of the WebView. We deliberately don't try a
    // soft `setState({ error: null })` retry: by the time we get
    // here the conversation engine and other long-lived listeners
    // may all be in inconsistent states, and a fresh JS context is
    // the only thing we can safely guarantee.
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <Fallback error={error} onReload={this.handleReload} />;
  }
}

function Fallback({
  error,
  onReload,
}: {
  error: Error;
  onReload: () => void;
}) {
  // Honour the user's saved theme pick even when the React tree
  // crashed: the boundary lives outside the `ThemeProvider`, so
  // we replay the same resolution logic the store does
  // (`light`/`dark` overrides win over the OS, `system` falls
  // back to `prefers-color-scheme`). Reading is sync + side-
  // effect-free, so there's no risk of compounding the original
  // failure.
  const savedMode = readSavedMode();
  const osPrefersDark =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark =
    savedMode === 'dark' ||
    (savedMode === 'system' && osPrefersDark);

  const palette = isDark
    ? {
        bg: '#0a0a0a',
        surface: '#1a1a1a',
        text: '#f5f5f5',
        secondary: 'rgba(255, 255, 255, 0.72)',
        border: 'rgba(255, 255, 255, 0.08)',
        accent: '#FF9500',
      }
    : {
        bg: '#f5f5f7',
        surface: '#ffffff',
        text: '#111111',
        secondary: 'rgba(0, 0, 0, 0.65)',
        border: 'rgba(0, 0, 0, 0.08)',
        accent: '#FF9500',
      };

  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        // Vertical safe-area padding only (notch / Dynamic Island /
        // home indicator). `max(...)` keeps a comfortable minimum on
        // devices without insets. Horizontal gutters are enforced
        // by the inner card's `width: min(420px, 100vw - 56px)` so
        // we don't have to rely on `width: 100%` shrinking with
        // padding (some WebViews handle that interaction
        // unpredictably for `position: fixed; inset: 0` parents).
        paddingTop: 'max(28px, var(--inset-top, env(safe-area-inset-top, 0px)))',
        paddingBottom: 'max(28px, var(--inset-bottom, env(safe-area-inset-bottom, 0px)))',
        background: palette.bg,
        color: palette.text,
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
      }}
    >
      <div
        style={{
          // Math-explicit horizontal sizing: `min(420px, 100vw - 56px)`
          // means "the card is at most 420 px wide, never wider than
          // viewport minus 56 px (28 px guaranteed on each side)".
          // No dependency on parent padding being respected by
          // `width: 100%` - this works regardless of how the WebView
          // resolves percentage widths inside a fixed-position
          // container with padding.
          width: 'min(420px, calc(100vw - 56px))',
          boxSizing: 'border-box',
          background: palette.surface,
          border: `1px solid ${palette.border}`,
          borderRadius: 12,
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <h1
          style={{
            margin: 0,
            fontSize: '1.25rem',
            fontWeight: 600,
            letterSpacing: '-0.3px',
          }}
        >
          Something went wrong
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: '0.875rem',
            lineHeight: 1.5,
            color: palette.secondary,
          }}
        >
          The app hit an unexpected error. Reload to try again. If
          this keeps happening, please share the details below.
        </p>
        <pre
          style={{
            margin: 0,
            padding: 12,
            background: palette.bg,
            border: `1px solid ${palette.border}`,
            borderRadius: 8,
            fontSize: '0.75rem',
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, monospace',
            color: palette.secondary,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 200,
            overflowY: 'auto',
          }}
        >
          {error.message || error.toString()}
        </pre>
        <button
          type="button"
          onClick={onReload}
          style={{
            marginTop: 4,
            padding: '10px 20px',
            border: `1.5px solid ${palette.accent}`,
            borderRadius: 12,
            background: 'transparent',
            color: palette.accent,
            fontSize: '0.9rem',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Reload app
        </button>
      </div>
    </div>
  );
}
