import path from 'node:path';
import { defineConfig } from 'vite';

// demo 直接吃 @enso/pair 的 TS 源码
export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: {
      '@enso/pair': path.resolve(import.meta.dirname, '../../packages/pair/src/index.ts'),
    },
  },
  server: { port: 5173 },
});
