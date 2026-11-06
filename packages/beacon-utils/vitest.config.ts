import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
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
