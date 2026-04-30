import { createTheme, type Theme } from '@mui/material/styles';

/**
 * Minimal but production-shaped MUI theme.
 *
 * Two instances (light + dark) built from the same accent, selected at
 * runtime via `prefers-color-scheme`. Keeping both pre-built avoids a
 * visible flash when the user toggles their system appearance.
 */

const ACCENT = '#FF9500'; // Pollen-ish orange, matches the desktop app.
const RADIUS = 12;
const FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

function buildTheme(mode: 'light' | 'dark'): Theme {
  const isDark = mode === 'dark';
  return createTheme({
    // MUI v7 wraps every `sx` rule and most `styled()` declarations in
    // `@layer sx { ... }` / `@layer global { ... }` by default. We
    // mirror Emotion's `<style data-emotion>` text into Constructable
    // Stylesheets to get around the iOS 18.7 / `tauri://localhost`
    // bug (see `main.tsx` for the full explanation), and the mirror
    // pipes text through `CSSStyleSheet.replaceSync(...)`. That call
    // accepts plain rules but is unreliable around dynamically
    // wrapped `@layer` blocks in WebKit. Since we don't ship alongside
    // other CSS frameworks, layer isolation gives us no real benefit;
    // disabling it makes every MUI rule plain CSS, which the mirror
    // forwards cleanly.
    modularCssLayers: false,
    palette: {
      mode,
      primary: { main: ACCENT },
      background: {
        default: isDark ? '#0a0a0a' : '#f5f5f7',
        paper: isDark ? '#1a1a1a' : '#ffffff',
      },
      text: {
        primary: isDark ? '#f5f5f5' : '#111111',
        secondary: isDark ? 'rgba(255,255,255,0.72)' : 'rgba(0,0,0,0.65)',
      },
      divider: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
    },
    typography: {
      fontFamily: FONT_FAMILY,
      button: { textTransform: 'none', fontWeight: 600 },
    },
    shape: { borderRadius: RADIUS },
    components: {
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: { borderRadius: RADIUS, paddingInline: 20, paddingBlock: 10 },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: { backgroundImage: 'none' },
        },
      },
      MuiCard: {
        styleOverrides: {
          root: { borderRadius: RADIUS },
        },
      },
    },
  });
}

export const lightTheme = buildTheme('light');
export const darkTheme = buildTheme('dark');
