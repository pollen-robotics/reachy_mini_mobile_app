import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'node:path';

const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
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
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: ['es2021', 'chrome110', 'safari16'],
    sourcemap: !!process.env.TAURI_DEBUG,
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
  },
}));
