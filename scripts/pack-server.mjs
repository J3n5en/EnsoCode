#!/usr/bin/env node
// 把无界面服务端打成 npm 包 @ensocode/server：out/server 与 renderer 产物 + 精简后的运行时依赖。
// 打过补丁的依赖随包放在 out/node_modules（产物解析时先于包级 node_modules 命中；npm 的 bundleDependencies
// 会把它们的传递依赖当成随包而不解压），node-pty 换成带 Linux 预编译的 fork，免装编译工具链。
// 用法: node scripts/pack-server.mjs [--skip-build] [--out <dir>]
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateServerPackTgz } from './server-package/validate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const dest = path.resolve(outArg >= 0 ? args[outArg + 1] : path.join(root, 'dist'));
const stage = path.join(root, 'out', 'npm-server');
const rootPkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

const NAME = '@ensocode/server';
/** 打了补丁（patches/）的依赖：npm 用户装不到补丁版，随包发布 */
const VENDORED = ['@earendil-works/pi-coding-agent', '@rahularya01/pi-cursor'];
/** 可选能力，缺失时运行时降级（本地 llama 模型） */
const SKIP = new Set(['node-llama-cpp']);
/** 上游 node-pty 在 Linux 没有预编译，npm 用户机器上不一定有编译链 */
const OVERRIDE = { 'node-pty': 'npm:@lydell/node-pty@1.2.0-beta.18' };

const sh = (cmd, cmdArgs, cwd = root) => execFileSync(cmd, cmdArgs, { cwd, stdio: 'inherit' });

if (!args.includes('--skip-build')) {
  sh('pnpm', ['build']);
  sh('pnpm', ['exec', 'vite', 'build', '-c', 'vite.server.config.ts']);
  sh('pnpm', ['--filter', '@enso/phone', 'build']);
}

const noMaps = (src) => !src.endsWith('.map');
rmSync(stage, { recursive: true, force: true });
cpSync(path.join(root, 'out/server'), path.join(stage, 'out/server'), {
  recursive: true,
  filter: noMaps,
});
cpSync(path.join(root, 'out/renderer'), path.join(stage, 'out/renderer'), {
  recursive: true,
  filter: noMaps,
});
// 内置 web 提供的手机 PWA
cpSync(path.join(root, 'packages/phone/dist'), path.join(stage, 'out/phone'), {
  recursive: true,
  filter: noMaps,
});
cpSync(path.join(root, 'scripts/server-package/README.md'), path.join(stage, 'README.md'));
cpSync(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));

// 产物里实际 import 的第三方包
const imported = new Set();
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (file.endsWith('.js')) {
      const code = readFileSync(file, 'utf8');
      for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"'./][^"']*)["']/g)) {
        const spec = m[1];
        if (spec.startsWith('node:')) continue;
        imported.add(
          spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
        );
      }
    }
  }
};
walk(path.join(stage, 'out/server'));

const declared = { ...rootPkg.dependencies, ...rootPkg.optionalDependencies };
const dependencies = {};
for (const name of [...imported].sort()) {
  if (SKIP.has(name) || VENDORED.includes(name) || !declared[name]) continue;
  dependencies[name] = OVERRIDE[name] ?? declared[name];
}

for (const name of VENDORED) {
  const src = realpathSync(path.join(root, 'node_modules', name));
  cpSync(src, path.join(stage, 'out/node_modules', name), {
    recursive: true,
    dereference: true,
    filter: noMaps,
  });
  const pkg = JSON.parse(readFileSync(path.join(src, 'package.json'), 'utf8'));
  // 随包依赖自己的依赖由 npm 装在本包 node_modules 下：钉到本仓库实际装的版本，与本包已有的同名依赖以本包为准
  const siblings = src.slice(0, src.lastIndexOf(`${path.sep}node_modules${path.sep}`) + 13);
  for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
    const installed = path.join(siblings, dep, 'package.json');
    const version = existsSync(installed)
      ? JSON.parse(readFileSync(installed, 'utf8')).version
      : range;
    if (!VENDORED.includes(dep)) dependencies[dep] ??= OVERRIDE[dep] ?? version;
  }
}

const sorted = Object.fromEntries(
  Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))
);
writeFileSync(
  path.join(stage, 'package.json'),
  `${JSON.stringify(
    {
      name: NAME,
      version: rootPkg.version,
      description:
        'EnsoCode headless server: run agents on a Linux box, use them from your phone or browser',
      license: rootPkg.license,
      // provenance 校验要求与发布所在仓库一致
      repository: { type: 'git', url: 'git+https://github.com/J3n5en/EnsoCode.git' },
      type: 'module',
      bin: { 'enso-server': 'out/server/index.js' },
      files: ['out', 'README.md', 'LICENSE'],
      engines: { node: '>=22' },
      os: ['linux', 'darwin'],
      dependencies: sorted,
    },
    null,
    2
  )}\n`
);

mkdirSync(dest, { recursive: true });
sh('npm', ['pack', '--pack-destination', dest], stage);
const tgz = `${NAME.replace('@', '').replace('/', '-')}-${rootPkg.version}.tgz`;
const packed = path.join(dest, tgz);
// 发布前校验：缺浏览器版资源的包发出去，用户打开完整版只会看到「桌面端缺少浏览器版资源」。
// 与其靠用户发现，不如在打包这一刻直接失败（beta 与正式版同一条流水线）。
const validation = await validateServerPackTgz(packed);
if (!validation.ok) {
  rmSync(packed, { force: true });
  console.error(`\n打包校验失败：${validation.error}`);
  process.exit(1);
}
console.log(`\n${packed}${existsSync(packed) ? '' : ' (missing!)'}`);
