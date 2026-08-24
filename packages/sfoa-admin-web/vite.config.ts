import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const adminApiProxyTarget = process.env.SFOA_ADMIN_API_PROXY_TARGET ?? 'http://127.0.0.1:8081';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/admin/api': {
        target: adminApiProxyTarget,
        changeOrigin: false,
      },
    },
  },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['./src/**/*.test.ts', './src/**/*.test.tsx'],
    css: true,
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    restoreMocks: true,
    clearMocks: true,
  },
});
