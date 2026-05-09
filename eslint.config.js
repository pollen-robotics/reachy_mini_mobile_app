import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * Architectural layer rules.
 *
 * The codebase is organised into 3 horizontal tiers under `src/`:
 *
 *   - shared/    cross-cutting helpers (Tauri/browser/env wrappers).
 *                Lowest layer, depends on nothing else in src/.
 *
 *   - features/  non-UI logic (auth, ble, wifi, apps, session,
 *                conversation). Can depend on shared/ and on peer
 *                features. MUST NOT depend on ui/.
 *
 *   - ui/        all React UI, itself layered:
 *                  design/   atomic primitives + tokens
 *                  widgets/  composable bricks (depend on features for hooks)
 *                  panels/   feature compositions (depend on widgets + features)
 *                  screens/  top-level routes (depend on panels + features)
 *                Each tier can only depend on the tiers below it.
 *
 * The rules below are enforced via `no-restricted-imports`. Each
 * forbidden direction has a custom message so a violation explains
 * itself in the editor / `yarn lint` output without forcing the
 * dev to come read this file. Adding a new layer? Mirror the
 * pattern (one config block per files-glob, listing the layers it
 * is NOT allowed to import from).
 *
 * The patterns key off `@/...` aliases, which are now the standard
 * for cross-folder imports in this codebase. Same-feature relative
 * imports (`./X`, `../subfolder/Y`) bypass these rules - they're
 * intra-feature and always allowed.
 */
export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'src-tauri', 'vite.config.ts'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        HTMLIFrameElement: 'readonly',
      },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },

  // ─── Layer rule: features/ MUST NOT depend on ui/ ─────────────────
  {
    files: ['src/features/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/ui/**', '@/ui'],
              message:
                "features/ is the logic layer; it must not import from ui/. If a UI piece needs the data, expose a hook from features/ and have the UI consume it.",
            },
          ],
        },
      ],
    },
  },

  // ─── Layer rule: shared/ is the lowest layer ──────────────────────
  {
    files: ['src/shared/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/ui/**', '@/ui', '@/features/**', '@/features'],
              message:
                'shared/ is cross-cutting plumbing; it must not depend on ui/ or features/. If you need something feature-specific, the helper belongs IN that feature.',
            },
          ],
        },
      ],
    },
  },

  // ─── Layer rule: ui/design/ atomic primitives only ────────────────
  {
    files: ['src/ui/design/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@/ui/widgets/**',
                '@/ui/panels/**',
                '@/ui/screens/**',
                '@/features/**',
                '@/features',
              ],
              message:
                "ui/design/ contains atomic UI primitives (tokens + reusable visuals). It must not depend on widgets, panels, screens or features - those are higher layers that consume it.",
            },
          ],
        },
      ],
    },
  },

  // ─── Layer rule: ui/widgets/ ↛ panels / screens ───────────────────
  {
    files: ['src/ui/widgets/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/ui/panels/**', '@/ui/screens/**'],
              message:
                'ui/widgets/ are composable bricks. They must not depend on the panels or screens that mount them (that would create a backwards dependency). Importing from features/ is allowed and expected (e.g. for hook types like RobotSessionHandle).',
            },
          ],
        },
      ],
    },
  },

  // ─── Layer rule: ui/panels/ ↛ screens ─────────────────────────────
  {
    files: ['src/ui/panels/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/ui/screens/**'],
              message:
                'ui/panels/ are screen-agnostic feature compositions. They must not depend on the parent screens that mount them.',
            },
          ],
        },
      ],
    },
  }
);
