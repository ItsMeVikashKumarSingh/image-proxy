import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Use Node.js environment — Cloudflare Worker globals (Request, Response, fetch)
    // are natively available in Node 20+, so no special pool needed.
    environment: 'node',
    // Explicit imports from vitest — no auto-injected globals (keeps ESLint clean)
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.js'],
    },
  },
})
