import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const renderer = path.resolve(import.meta.dirname, '../../src/renderer');
const stub = (name: string) => path.resolve(import.meta.dirname, `src/stubs/${name}`);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // 数组形式：按顺序匹配，桩必须排在通配的 '@' 之前
    alias: [
      {
        find: '@enso/pair',
        replacement: path.resolve(import.meta.dirname, '../pair/src/index.ts'),
      },
      // 复用桌面聊天组件，但把它们对宿主的依赖换成 PWA 桩（桌面源码零改动）
      { find: /^@\/i18n$/, replacement: stub('i18n.tsx') },
      { find: /^@\/stores\/settings$/, replacement: stub('settings-store.ts') },
      { find: /^@\/stores\/sessions$/, replacement: stub('sessions-store.ts') },
      { find: /^@\//, replacement: `${renderer}/` },
      { find: '@shared', replacement: path.resolve(import.meta.dirname, '../../src/shared') },
    ],
  },
  server: { host: true, port: 5174 },
  build: { target: 'es2022' },
});
