import { builtinModules } from 'node:module';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import pkg from './package.json';

// main 段一旦自定义 rollupOptions.input，electron-vite 的默认 external 不再生效，
// electron 与 dependencies 会被打进产物（见 spec/big-question/preload-externalization.md 同类坑），
// 故显式复刻默认 external。
const deps = Object.keys(pkg.dependencies);
const nodeExternal = [
  'electron',
  /^electron\/.+/,
  ...builtinModules.flatMap((m) => [m, `node:${m}`]),
  ...deps,
  new RegExp(`^(${deps.join('|')})/`),
];

export default defineConfig({
  main: {
    build: {
      externalizeDeps: true,
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/main/index.ts'),
          // agent worker：utilityProcess 入口，与 main 同构建段以复用 external 配置
          agent: path.resolve(__dirname, 'src/agent/index.ts'),
        },
        external: nodeExternal,
      },
    },
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, 'src/shared'),
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: true,
    },
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, 'src/shared'),
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    define: {
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src/renderer'),
        '@shared': path.resolve(__dirname, 'src/shared'),
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/renderer/index.html'),
          settings: path.resolve(__dirname, 'src/renderer/settings.html'),
        },
      },
    },
  },
});
