import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import svgr from 'vite-plugin-svgr';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const host = process.env.TAURI_DEV_HOST;

// Read the app version from package.json at build time so the splash
// (and any future "About" surface) can render it without us having to
// remember to bump a constant alongside the npm version. Read with
// `node:fs` rather than a JSON import so the tsconfig stays free of
// `resolveJsonModule` and works in strict ESM mode under Vite 7.
const pkg = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8'),
) as { version: string };
// The git tag is the single source of truth for a release version:
// on a `vX.Y.Z` tag the CI exports `APP_VERSION` so the in-app version
// (splash, About) matches the native bundle version without anyone
// bumping package.json. Locally / on non-tag builds we fall back to
// package.json. A leading `v` from the raw tag is stripped.
const APP_VERSION = (process.env.APP_VERSION || pkg.version).replace(/^v/, '');

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  // `vite-plugin-svgr` lets us import any SVG asset as a React
  // component via the `?react` query suffix (e.g.
  // `import RobotSvg from '@/assets/robot--icon.svg?react'`).
  // The component renders the SVG inline, so consumers can style
  // it with CSS / `currentColor` / `sx`. SVGs imported without
  // the suffix still resolve to a URL string (legacy `*.svg`
  // module declaration in `vite-env.d.ts`).
  //
  // `svgrOptions`
  // ─────────────
  // - `icon: true` : render the SVG component at `1em × 1em` with
  //   a viewBox derived from the source `width/height`. Matches
  //   MUI's `SvgIcon` sizing convention, so consumers drive the
  //   size with `font-size` (no per-call-site `width/height`
  //   plumbing needed).
  // - `replaceAttrValues` : at build time, normalise any black
  //   ink (`#000`, `#000000`) to `currentColor` on every imported
  //   SVG. This means a designer can re-export the asset from
  //   Figma / Sketch (which always emit hex colours) and the
  //   icon will keep inheriting the host's CSS `color` (selected
  //   nav state, hover, etc.) without anyone having to hand-edit
  //   the file. Add more entries here when you onboard new
  //   palettes.
  plugins: [
    react(),
    svgr({
      svgrOptions: {
        icon: true,
        replaceAttrValues: {
          '#000': 'currentColor',
          '#000000': 'currentColor',
          black: 'currentColor',
        },
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(process.cwd(), 'src'),
    },
  },
  // Vite options tailored for Tauri:
  //  - `server.host` must be reachable from the device/emulator,
  //  - `server.strictPort` prevents silent fallback to another port,
  //  - `envPrefix` lets us expose `TAURI_*` env vars to the frontend.
  //
  // Port 1422 (HMR 1423) is deliberately offset from the desktop
  // app's 1420 / 1421 pair so both Tauri dev servers can run side
  // by side on a single workstation without colliding. Update both
  // here AND in `src-tauri/tauri.conf.json`'s `devUrl` if you ever
  // change them - `strictPort` makes the conflict loud rather than
  // silent.
  clearScreen: false,
  server: {
    port: 1422,
    strictPort: true,
    host: host ?? false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1423,
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
    // Allow the dev server to read the locally linked SDK build. When
    // `@pollen-robotics/reachy-mini-sdk` is a `link:` dependency it
    // resolves to a sibling repo (`../reachy_mini/ts`) outside this
    // app's root, which Vite's default `fs.strict` would otherwise
    // refuse to serve. Allowing the parent folder covers both repos
    // while keeping everything else off-limits. Harmless when the dep
    // is a normal published version (nothing outside root is imported).
    fs: {
      allow: [path.resolve(process.cwd(), '..'), path.resolve(process.cwd())],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  // Bake the npm `package.json` version into the bundle so the splash
  // (and future "About" / settings surfaces) can render it without
  // an extra runtime lookup. Stringified per Vite's contract: the
  // value is inlined verbatim, so we ship `'0.3.2'` not `0.3.2`.
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  build: {
    target: ['es2021', 'chrome110', 'safari16'],
    sourcemap: !!process.env.TAURI_DEBUG,
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
  },
}));
