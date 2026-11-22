import { builtinModules } from 'node:module';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import pkg from './package.json';

// 无界面宿主：同一份核心代码，`@platform` 换成 Node 实现；依赖保持 external，由 node_modules 提供原生模块。
const deps = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
];
const isExternal = (id: string) =>
  id.startsWith('node:') ||
  builtinModules.includes(id) ||
  deps.some((dep) => id === dep || id.startsWith(`${dep}/`));

const NODE_WORKER = '?nodeWorker';

/** 与 electron-vite 的 `?nodeWorker` 同义：worker 单独成 chunk，默认导出按 options 起 worker_threads */
function nodeWorker(): Plugin {
  return {
    name: 'enso:node-worker',
    enforce: 'pre',
    async resolveId(id, importer) {
      if (!id.endsWith(NODE_WORKER)) return null;
      const resolved = await this.resolve(id.slice(0, -NODE_WORKER.length), importer);
      return resolved ? `${resolved.id}${NODE_WORKER}` : null;
    },
    load(id) {
      if (!id.endsWith(NODE_WORKER)) return null;
      const ref = this.emitFile({ type: 'chunk', id: id.slice(0, -NODE_WORKER.length) });
      return [
        "import { Worker } from 'node:worker_threads';",
        `export default (options) => new Worker(new URL(import.meta.ROLLUP_FILE_URL_${ref}), options);`,
      ].join('\n');
    },
  };
}

export default defineConfig({
  plugins: [nodeWorker()],
  // ws 打进产物后，可选的 bufferutil / utf-8-validate 被换成空对象，ws 会误以为装了原生加速而调用失败
  define: {
    'process.env.WS_NO_BUFFER_UTIL': '"1"',
    'process.env.WS_NO_UTF_8_VALIDATE': '"1"',
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@enso/pair': path.resolve(__dirname, 'packages/pair/src/index.ts'),
      '@platform': path.resolve(__dirname, 'src/server/platform.ts'),
    },
  },
  // 只有 package.json dependencies 留作外部依赖（见 isExternal），其余（如 devDependencies 里的 qrcode）打进产物
  ssr: { noExternal: true },
  build: {
    ssr: true,
    target: 'node22',
    outDir: 'out/server',
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, 'src/server/index.ts'),
        agent: path.resolve(__dirname, 'src/agent/index.ts'),
        'plugin-host': path.resolve(__dirname, 'src/pluginHost/index.ts'),
        'memory-service': path.resolve(__dirname, 'src/memoryService/index.ts'),
      },
      external: isExternal,
      output: {
        format: 'es',
        // index.js 即 npm 包的 bin
        banner: (chunk) => (chunk.isEntry && chunk.name === 'index' ? '#!/usr/bin/env node' : ''),
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
});
