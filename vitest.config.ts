import path from 'node:path';
import { defineConfig } from 'vitest/config';

const root = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(root, 'src/shared'),
      '@': path.resolve(root, 'src/renderer'),
      '@enso/pair': path.resolve(root, 'packages/pair/src/index.ts'),
      // 主进程模块顶层会 import electron，node 环境下用桩替换
      electron: path.resolve(root, 'test/stubs/electron.ts'),
      '@electron-toolkit/utils': path.resolve(root, 'test/stubs/electron-toolkit-utils.ts'),
    },
  },
  test: {
    // 主进程逻辑跑在 node 环境；渲染层若日后加测试再按目录覆盖
    environment: 'node',
    include: ['src/**/*.test.ts', 'packages/**/*.test.ts'],
  },
});
