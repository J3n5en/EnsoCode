import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { desktopStubs } from './src/desktopStubs';
import { injectShellManifest, shellFiles, stampShellVersion } from './src/shellPrecache';
import { startupImageLinks } from './src/startupImages';

/** 构建时固化当前 commit 短哈希，侧边栏展示版本用（非 git 环境降级为 dev） */
const commit = (() => {
  try {
    const hash = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    const dirty = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return dirty ? `${hash}-dirty` : hash;
  } catch {
    return 'dev';
  }
})();

const renderer = path.resolve(import.meta.dirname, '../../src/renderer');
const stub = (name: string) => path.resolve(import.meta.dirname, `src/stubs/${name}`);

/** 复用桌面聊天组件，但把它们对宿主的依赖换成 PWA 桩（桌面源码零改动）：`@/` 模块名 → [真实文件, 桩] */
const stubbed: [string, string, string][] = [
  ['i18n', 'i18n.ts', 'i18n.tsx'],
  ['stores/settings', 'stores/settings/index.ts', 'settings-store.ts'],
  ['stores/sessions', 'stores/sessions/index.ts', 'sessions-store.ts'],
  ['lib/ghosttyTheme', 'lib/ghosttyTheme.ts', 'ghostty-theme.ts'],
];

/** iOS 启动图（public/splash，scripts/startup-images.ts 生成）：两个入口页都要声明，主屏打开哪个都能用上 */
const startupImages = (): Plugin => ({
  name: 'enso-startup-images',
  transformIndexHtml: (html) => html.replace('</head>', `  ${startupImageLinks()}\n  </head>`),
});

/** 构建完把壳清单和版本写进 sw.js，页面记下自己的版本（见 src/shellPrecache.ts） */
const shellPrecache = (): Plugin => {
  let outDir = '';
  return {
    name: 'enso-shell-precache',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const read = (name: string) => fs.readFileSync(path.join(outDir, name), 'utf8');
      const index = read('index.html');
      const desk = read('desk.html');
      const version = createHash('sha256').update(index).update('\0').update(desk).digest('hex');
      const short = version.slice(0, 16);
      fs.writeFileSync(path.join(outDir, 'index.html'), stampShellVersion(index, short));
      fs.writeFileSync(path.join(outDir, 'desk.html'), stampShellVersion(desk, short));
      fs.writeFileSync(
        path.join(outDir, 'sw.js'),
        injectShellManifest(read('sw.js'), short, shellFiles(desk))
      );
    },
  };
};

export default defineConfig({
  define: { __COMMIT__: JSON.stringify(commit) },
  plugins: [
    desktopStubs(
      Object.fromEntries(stubbed.map(([, real, name]) => [path.join(renderer, real), stub(name)]))
    ),
    react(),
    tailwindcss(),
    startupImages(),
    shellPrecache(),
  ],
  resolve: {
    // 数组形式：按顺序匹配，桩必须排在通配的 '@' 之前
    alias: [
      {
        find: '@enso/pair',
        replacement: path.resolve(import.meta.dirname, '../pair/src/index.ts'),
      },
      // 只认整名：字符串形式会按前缀把 @/stores/sessions/timeline 也换掉
      ...stubbed.map(([name, , file]) => ({
        find: new RegExp(`^@/${name}$`),
        replacement: stub(file),
      })),
      { find: /^@\//, replacement: `${renderer}/` },
      { find: '@shared', replacement: path.resolve(import.meta.dirname, '../../src/shared') },
    ],
  },
  server: { host: true, port: 5174 },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, 'index.html'),
        desk: path.resolve(import.meta.dirname, 'desk.html'),
      },
    },
  },
});
