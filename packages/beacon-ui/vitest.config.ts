import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
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
