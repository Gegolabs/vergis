import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@vergis/botler': fileURLToPath(new URL('./packages/botler/src/index.ts', import.meta.url)),
      '@vergis/capabilities': fileURLToPath(new URL('./packages/capabilities/src/index.ts', import.meta.url)),
      '@vergis/mira': fileURLToPath(new URL('./packages/mira/src/index.ts', import.meta.url)),
      '@vergis/policy': fileURLToPath(new URL('./packages/policy/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
