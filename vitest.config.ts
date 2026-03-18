import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@copilot': path.resolve(__dirname, 'src/copilot'),
      '@converter': path.resolve(__dirname, 'src/converter'),
      '@proxy': path.resolve(__dirname, 'src/proxy'),
      '@store': path.resolve(__dirname, 'src/store'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: [
      'src/**/__tests__/**/*.test.ts',
    ],
    coverage: {
      enabled: true,
      reporter: ['text', 'lcov'],
      include: [
        'src/converter/**/*.ts',
        'src/copilot/**/*.ts',
        'src/proxy/**/*.ts',
        'src/shared/**/*.ts',
      ],
      exclude: [
        'src/**/__tests__/**',
        'src/**/types.ts',
        'src/test-*.ts',
        'src/main/**',
        'src/renderer/**',
        'src/store/**',
        'src/proxy/server.ts',
      ],
    },
  },
})
