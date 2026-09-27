import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// The C0 suite renders the real app in jsdom against a real GraphQL server
// (apps/server/src/main.ts on an ephemeral port, spawned by the suite itself),
// so this file stays deliberately narrow: one entry point, no watch, no
// browser-mode dev server, long timeouts for the server boot.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/__tests__/c0.acceptance.test.tsx'],
    setupFiles: ['src/__tests__/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 90_000,
    restoreMocks: true,
  },
})
