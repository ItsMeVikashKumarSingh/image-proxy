import js from '@eslint/js'
import globals from 'globals'

export default [
  // ── Ignored paths ────────────────────────────────────────────────────────
  {
    ignores: ['node_modules/**', '.wrangler/**', 'dist/**'],
  },

  // ── Source files: Cloudflare Worker runtime ───────────────────────────────
  {
    files: ['src/**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Cloudflare Workers runtime provides Web APIs globally
        ...globals.browser,
        // Override specifics — Workers runtime has no 'window'
        window: 'off',
        document: 'off',
        // Workers-specific globals
        Request: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
        ReadableStream: 'readonly',
        Headers: 'readonly',
        Uint8Array: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-console': 'off',         // Workers use console.error/log for observability
      'prefer-const': 'error',
      'no-var': 'error',
      'eqeqeq': ['error', 'always'],
      'no-throw-literal': 'error',
      'no-implicit-coercion': 'error',
    },
  },

  // ── Test files: Node.js environment (vitest) ──────────────────────────────
  {
    files: ['test/**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
        // Vitest explicit imports — no globals used
        Request: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        Headers: 'readonly',
        Uint8Array: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
]
