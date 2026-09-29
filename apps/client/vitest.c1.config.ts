import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

/**
 * C1 suite config. Same environment as C0 (jsdom, the shared setup file), a
 * separate entry point so C0's verdicts stay independent of C1's fixtures.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/__tests__/c1.acceptance.test.tsx', 'src/__tests__/c1.display-name.test.ts', 'src/__tests__/notice.test.tsx'],
    setupFiles: ['./src/__tests__/setup.ts'],
    // The suite boots a real server and drives four screens through real
    // queries, so it needs more room than a unit run.
    testTimeout: 120_000,
    hookTimeout: 150_000,
    restoreMocks: true,
    // Unhandled rejections are reported by the harness instead: it allowlists
    // exactly one Apollo-internal teardown abort and collects everything else,
    // which `c1.acceptance.test.tsx` asserts is empty. Vitest's own reporting is
    // all-or-nothing, which would mean trusting the app's error handling less,
    // not more.
    dangerouslyIgnoreUnhandledErrors: true,
  },
})
