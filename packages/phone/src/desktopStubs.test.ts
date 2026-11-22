import path from 'node:path';
import { build, loadConfigFromFile, type Plugin, type Rollup } from 'vite';
import { describe, expect, it } from 'vitest';

const phone = path.resolve(import.meta.dirname, '..');
const renderer = path.resolve(phone, '../../src/renderer');
const realModules = [
  'stores/sessions/index.ts',
  'stores/settings/index.ts',
  'i18n.ts',
  'lib/ghosttyTheme.ts',
].map((file) => path.join(renderer, file));

const flatten = (value: unknown): unknown[] =>
  Array.isArray(value) ? value.flatMap(flatten) : [value];

/** 用精简壳的真实 resolve 配置与桩插件打包 entry，返回进包的模块 */
async function bundledModules(entry: string): Promise<string[]> {
  const loaded = await loadConfigFromFile(
    { command: 'build', mode: 'production' },
    path.join(phone, 'vite.config.ts'),
    phone,
    'silent'
  );
  const config = loaded?.config;
  if (!config) throw new Error('vite.config.ts 未加载');
  const plugins = flatten(config.plugins).filter(
    (p): p is Plugin => !!p && (p as Plugin).name === 'enso-desktop-stubs'
  );
  const result = await build({
    configFile: false,
    root: phone,
    logLevel: 'silent',
    define: config.define,
    resolve: config.resolve,
    plugins,
    build: { write: false, rollupOptions: { input: entry } },
  });
  const outputs = (Array.isArray(result) ? result : [result]) as Rollup.RollupOutput[];
  return outputs.flatMap((o) =>
    o.output.flatMap((chunk) => (chunk.type === 'chunk' ? Object.keys(chunk.modules) : []))
  );
}

describe('精简壳不打包桌面真 store', () => {
  it('App 依赖图（含 TimelineRow → secretaryReturn）只用桩', async () => {
    const modules = await bundledModules(path.join(phone, 'src/App.tsx'));
    expect(modules.filter((id) => realModules.includes(id))).toEqual([]);
    expect(modules).toContain(path.join(phone, 'src/stubs/sessions-store.ts'));
  }, 120_000);

  it('桌面源码里的相对导入（stores/backgroundTasksView 的 ./sessions）也换成桩', async () => {
    const modules = await bundledModules(path.join(renderer, 'stores/backgroundTasksView.ts'));
    expect(modules.filter((id) => realModules.includes(id))).toEqual([]);
    expect(modules).toContain(path.join(phone, 'src/stubs/sessions-store.ts'));
  }, 120_000);
});
