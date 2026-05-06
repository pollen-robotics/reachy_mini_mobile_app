import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Vitest configuration.
 *
 * Kept separate from `vite.config.ts` because the latter is a
 * function-returning-async config tailored for Tauri dev/build,
 * which Vitest can't consume directly.
 *
 * Tests target pure utility functions only (parsers, mappers,
 * extractors). We don't render any React component yet, so the
 * default Node environment is enough - no `jsdom` overhead.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(process.cwd(), 'src'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // Tauri-specific Rust sources sometimes appear in the workspace;
    // make sure Vitest never tries to scan them.
    exclude: ['node_modules', 'dist', 'src-tauri'],
    reporters: ['default'],
  },
});
