import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

/**
 * C2 suite config. Same environment as C0 and C1 (jsdom, the shared setup file),
 * a third entry point so C2's verdicts stay independent of both: the booking
 * screens' fixtures (rooms, equipment, two requesters and a handful of bookings)
 * must not be able to change what C0 or C1 concluded, and vice versa.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: [
      'src/__tests__/c2.acceptance.test.tsx',
      'src/__tests__/c2.detail.test.tsx',
      'src/__tests__/c2.approvals.test.tsx',
      'src/__tests__/c2.availability.test.tsx',
      // The static reuse proof. No server, no fixtures — it reads the source
      // tree — so it is a file of its own rather than part of a server-backed
      // file: it must be runnable when nothing else is, and its verdict must not
      // depend on a database.
      'src/__tests__/c2.reuse.test.ts',
    ],
    setupFiles: ['./src/__tests__/setup.ts'],
    // One file at a time, even though each file still boots its own real server on
    // its own ephemeral port. Three at once means three `tsx` spawns compiling the
    // whole server and initialising TypeORM against *one* development database
    // simultaneously, and the odd one then misses the harness's health wait and
    // its whole file is reported as skipped — a `beforeAll` that never ran, which
    // reads like a pass and is not one. Serialising the files costs wall-clock and
    // removes the contention; nothing else changes, so each file's verdicts, its
    // fixtures and its own server stay exactly as they were. The health timeout is
    // deliberately left alone: the contention was the cause, not the budget.
    fileParallelism: false,
    // The suite boots a real server and drives real mutations, so it needs more
    // room than a unit run.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    restoreMocks: true,
    // Unhandled rejections are reported by the harness instead: it allowlists
    // exactly two Apollo-internal throws (a teardown abort, and a refused
    // mutation's `CombinedGraphQLErrors`) and collects everything else, which
    // `c2.acceptance.test.tsx` asserts is empty. A booking create that the server
    // refuses is a real case in this suite, and Vitest's all-or-nothing reporting
    // would only tell me *that* something escaped, not that it was Apollo's.
    dangerouslyIgnoreUnhandledErrors: true,
  },
})
