// 用法（在仓库根目录，需 node_modules）：node mockups/bg-task-cleanup/build.mjs
// 把 src/screens.tsx 的每个画面预渲染成纯静态 HTML，Tailwind 编译成 site/mockup.css。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/vite';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const site = resolve(here, 'site');
const base = '/mockups/bg-task-cleanup';

const server = await createServer({
  root,
  configFile: false,
  logLevel: 'warn',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, watch: null },
  plugins: [tailwind()],
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: { '@shared': resolve(root, 'src/shared'), '@': resolve(root, 'src/renderer') },
  },
});

try {
  const { screens } = await server.ssrLoadModule(`${base}/src/screens.tsx`);
  const css = (await server.ssrLoadModule(`${base}/styles.css?inline`)).default;
  mkdirSync(site, { recursive: true });
  writeFileSync(resolve(site, 'mockup.css'), css);
  const page = (title, body) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${title}</title>
<link rel="stylesheet" href="mockup.css">
<script>if (location.hash === '#dark') document.documentElement.classList.add('dark');</script>
</head>
<body>${body}</body>
</html>
`;
  for (const s of screens) {
    writeFileSync(
      resolve(site, `${s.id}.html`),
      page(`${s.id} · ${s.title}`, renderToStaticMarkup(s.element))
    );
  }
  const links = screens
    .map(
      (s) =>
        `<li><b>${s.id}</b> ${s.title}：<a href="${s.id}.html">浅色</a> · <a href="${s.id}.html#dark">深色</a></li>`
    )
    .join('\n');
  writeFileSync(
    resolve(site, 'index.html'),
    page(
      '后台任务收尾 mockup',
      `<main style="padding:32px;line-height:2"><h1>后台任务收尾与闲置提醒 · mockup</h1><ul>${links}</ul></main>`
    )
  );
  console.log(`built ${screens.length} screens → ${site}`);
} finally {
  await server.close();
}
