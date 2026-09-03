import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/renderer/src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url))
    }
  },
  esbuild: { jsx: 'automatic' },
  test: { include: ['tests/**/*.test.{ts,tsx}'], testTimeout: 10000 }
})
