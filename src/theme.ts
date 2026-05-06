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
    palette: {
      mode,
      primary: { main: ACCENT },
      background: {
        // Lighter "canvas" tone so the contrast with the white
        // cards (`paper`) is subtle - the cards still pop but
        // the body doesn't feel "hard" grey. The dark mode
        // counterpart bumps from pitch black to a softer near-
        // black so the cards (#1a1a1a) still stand out without
        // the body crushing into the OLED's true black.
        default: isDark ? '#101013' : '#fafafa',
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
