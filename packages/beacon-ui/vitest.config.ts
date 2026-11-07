import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Browser tests use ESM builds, avoiding require(ESM) in Node 22's VM loader.
    alias: {
      src: fileURLToPath(new URL('./src', import.meta.url)),
      '@ecadlabs/beacon-core': fileURLToPath(
        new URL('../beacon-core/dist/esm/index.js', import.meta.url)
      ),
      '@ecadlabs/beacon-utils': fileURLToPath(
        new URL('../beacon-utils/dist/esm/index.js', import.meta.url)
      ),
      '@ecadlabs/beacon-types': fileURLToPath(
        new URL('../beacon-types/dist/esm/index.js', import.meta.url)
      )
    }
  },
  test: {
    environment: 'jsdom',
    // Use jsdom's own global context for DOM event constructors and window identity.
    pool: 'vmThreads',
    globals: true,
    clearMocks: true,
    setupFiles: ['./vitest-setup.ts'],
    include: ['__tests__/**/*.test.{ts,tsx,js}'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      reporter: ['text', 'lcov', 'json-summary']
    }
  }
})
