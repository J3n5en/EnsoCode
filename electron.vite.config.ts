import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import pkg from './package.json';

// 合并说明：dev 曾为手工 multi-input 显式复刻默认 external（nodeExternal）。
// 本分支已改用 `?modulePath` 独立构建 agent worker、main 保持官方单入口，
// 默认 external 自然生效，nodeExternal 随之成为死代码，故一并移除。

// @enso/pair 是 workspace 内的 TS 源码包，需被打进产物（不可 external），
// 三段统一用 alias 指到源码入口。
const pairAlias = path.resolve(__dirname, 'packages/pair/src/index.ts');

// 验收脚本并行时不能一起撞 vite 的默认 5173。只在显式指定时绑死端口。
function rendererDevServer(): { host: string; port: number; strictPort: true } | undefined {
  const raw = process.env.ENSO_RENDERER_PORT?.trim();
  if (!raw) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`ENSO_RENDERER_PORT must be an integer TCP port`);
  }
  return { host: '127.0.0.1', port, strictPort: true };
}

const rendererServer = rendererDevServer();

export default defineConfig({
  main: {
    // ws 打进产物后，可选的 bufferutil / utf-8-validate 被换成空对象，关掉防止首个入站帧崩溃
    define: {
      'process.env.WS_NO_BUFFER_UTIL': '"1"',
      'process.env.WS_NO_UTF_8_VALIDATE': '"1"',
    },
    build: {
      // Agent utilityProcess 走 `?modulePath` isolated build；Main 保持官方单入口，
      // 避免手工 multi-input 把无 export 的启动入口 tree-shake 成 0B facade。
      externalizeDeps: true,
      rollupOptions: {
        // externalizeDeps 只认 dependencies；node-llama-cpp 在 optionalDependencies 里，
        // 被打进 bundle 后它对 .node 绑定的动态 require 会失效。
        external: ['node-llama-cpp'],
      },
    },
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, 'src/shared'),
        '@enso/pair': pairAlias,
        '@platform': path.resolve(__dirname, 'src/main/desktop/platform.ts'),
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: true,
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/preload/index.ts'),
          // 远程节点壳（主窗口节点层与节点设置窗口）：只暴露 __ensoRemote
          nodeRemote: path.resolve(__dirname, 'src/preload/nodeRemote.ts'),
          // 拖放浮窗：不暴露 API，只处理拖放
          dropShelf: path.resolve(__dirname, 'src/preload/dropShelf.ts'),
        },
      },
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
        '@enso/pair': pairAlias,
      },
    },
    // diff 高亮 worker（@pierre/diffs）含动态 import，iife 格式打不了，需 es
    worker: { format: 'es' },
    build: {
      // electron-vite renderer 默认 minify:false，未压缩的 mermaid/shiki chunk 有十几 MB
      minify: 'esbuild',
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/renderer/index.html'),
        },
      },
    },
    ...(rendererServer ? { server: rendererServer } : {}),
  },
});
