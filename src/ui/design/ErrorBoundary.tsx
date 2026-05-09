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
    // here the conversation engine, BLE listeners, etc. may all
    // be in inconsistent states, and a fresh JS context is the
    // only thing we can safely guarantee.
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
  const isDark =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;

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
        // `max(28px, env(...))` honours the device's hardware safe
        // area (notch, Dynamic Island, home indicator) on iOS / Android
        // while still keeping a comfortable 28 px gutter on devices
        // without one. Using individual side properties (instead of the
        // shorthand) so each edge gets its own inset; the previous
        // constant `padding: 24` had the card touching the screen edges
        // on notched devices because the WebView's body extends
        // edge-to-edge into those zones.
        paddingTop: 'max(28px, env(safe-area-inset-top, 0px))',
        paddingRight: 'max(28px, env(safe-area-inset-right, 0px))',
        paddingBottom: 'max(28px, env(safe-area-inset-bottom, 0px))',
        paddingLeft: 'max(28px, env(safe-area-inset-left, 0px))',
        background: palette.bg,
        color: palette.text,
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
      }}
    >
      <div
        style={{
          maxWidth: 420,
          width: '100%',
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
