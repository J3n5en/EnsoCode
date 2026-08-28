import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@enso/pair': path.resolve(import.meta.dirname, '../pair/src/index.ts'),
    },
  },
  server: { host: true, port: 5174 },
  build: { target: 'es2022' },
});
