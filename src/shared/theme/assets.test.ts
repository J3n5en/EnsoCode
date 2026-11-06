import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IMAGE_EXTENSIONS } from '../localImage';
import {
  isThemeAssetPath,
  parseThemeAssets,
  resolveThemeAssets,
  THEME_ASSET_EXTENSIONS,
  themeAssetsCss,
} from './assets';
import { parseThemeFile } from './themeFile';

const ok = { src: 'assets/a.webp' };

describe('assets 模块边界', () => {
  it('只引用同目录模块，可原样拷到主题生成器', () => {
    const source = readFileSync(new URL('./assets.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(imports.every((path) => /^\.\/[^/]+$/.test(path))).toBe(true);
  });

  it('图片扩展名与插件资源协议一致', () => {
    expect([...THEME_ASSET_EXTENSIONS].sort()).toEqual([...IMAGE_EXTENSIONS].sort());
  });

  it.each([
    ['a.webp', true],
    ['dir/A.PNG', true],
    ['.webp', false],
    ['a.webp/', false],
    ['a..b/c.png', true],
  ])('isThemeAssetPath(%s) → %s', (path, expected) => {
    expect(isThemeAssetPath(path)).toBe(expected);
  });
});

describe('parseThemeAssets', () => {
  it('保留合法槽位的全部变体', () => {
    const asset = {
      src: 'assets/busy.webp',
      still: 'assets/busy-still.png',
      dark: 'dark/奶龙.svg',
      states: { running: 'a.gif', waiting: 'b.avif', error: 'c.jpg' },
    };
    expect(parseThemeAssets({ thinking: asset, welcome: ok })).toEqual({
      thinking: asset,
      welcome: ok,
    });
  });

  it.each<[string, unknown]>([
    ['不是对象', 'a.webp'],
    ['缺 src', { still: 'a.webp' }],
    ['src 不是字符串', { src: 1 }],
    ['空路径', { src: '' }],
    ['绝对路径', { src: '/a.webp' }],
    ['上跳', { src: '../a.webp' }],
    ['中间上跳', { src: 'a/../../b.webp' }],
    ['当前目录段', { src: './a.webp' }],
    ['空段', { src: 'a//b.webp' }],
    ['反斜杠', { src: 'a\\b.webp' }],
    ['带协议', { src: 'https://x.test/a.webp' }],
    ['百分号编码', { src: '%2e%2e/a.webp' }],
    ['带引号', { src: 'a").webp' }],
    ['带查询', { src: 'a.webp?x=1' }],
    ['非图片扩展名', { src: 'a.css' }],
    ['无扩展名', { src: 'assets/a' }],
    ['still 越界', { ...ok, still: '../a.webp' }],
    ['dark 非图片', { ...ok, dark: 'a.woff2' }],
    ['states 不是对象', { ...ok, states: 'a.webp' }],
    ['states 未知状态', { ...ok, states: { idle: 'a.webp' } }],
    ['states 值不合法', { ...ok, states: { running: '/a.webp' } }],
  ])('%s 时丢弃该槽位，其他槽位保留', (_label, bad) => {
    expect(parseThemeAssets({ welcome: bad, 'code-corner': ok })).toEqual({ 'code-corner': ok });
  });

  it('丢弃未知槽位；全部无效或不是对象时没有 assets', () => {
    expect(parseThemeAssets({ nope: ok, welcome: ok })).toEqual({ welcome: ok });
    expect(parseThemeAssets({ nope: ok })).toBeUndefined();
    expect(parseThemeAssets([ok])).toBeUndefined();
    expect(parseThemeAssets(undefined)).toBeUndefined();
  });
});

describe('parseThemeFile 的 assets', () => {
  const palette = {
    canvas: '#000',
    surface: '#000',
    sunken: '#000',
    border: '#000',
    borderStrong: '#000',
    text: '#fff',
    textMuted: '#fff',
    textSubtle: '#fff',
    accent: '#f00',
  };

  it('带出合法槽位，坏 assets 不让主题失败', () => {
    const good = parseThemeFile({ light: palette, dark: palette, assets: { welcome: ok } });
    expect(good.ok && good.assets).toEqual({ welcome: ok });
    const bad = parseThemeFile({ light: palette, dark: palette, assets: 'x' });
    expect(bad).toEqual({ ok: true, light: palette, dark: palette });
  });
});

describe('resolveThemeAssets', () => {
  it('按主题 JSON 所在目录解析每个路径', () => {
    const resolved = resolveThemeAssets(
      { thinking: { src: 'a.webp', still: 'b/c.webp', states: { error: 'e.webp' } } },
      'themes/x.json',
      (rel) => `u:${rel}`
    );
    expect(resolved).toEqual({
      thinking: {
        src: 'u:themes/a.webp',
        still: 'u:themes/b/c.webp',
        states: { error: 'u:themes/e.webp' },
      },
    });
    expect(resolveThemeAssets({ welcome: ok }, 'x.json', (rel) => rel)).toEqual({ welcome: ok });
  });
});

describe('themeAssetsCss', () => {
  it('没有素材时不生成 CSS', () => {
    expect(themeAssetsCss(undefined)).toBe('');
    expect(themeAssetsCss({})).toBe('');
  });

  it.each<[string, Parameters<typeof themeAssetsCss>[0], string[]]>([
    [
      '默认图写进变量并挂到槽位',
      { welcome: { src: 'u/w' } },
      [
        ':root{--enso-asset-welcome:url("u/w")}',
        '[data-enso="timeline"]:not(:has([data-enso="message-user"]))::after{',
        'var(--enso-asset-welcome)',
      ],
    ],
    [
      '减少动态效果时换静帧',
      { welcome: { src: 'u/w', still: 'u/s' } },
      [
        '@media (prefers-reduced-motion: reduce){:root,:root.dark{--enso-asset-welcome:url("u/s")}}',
      ],
    ],
    [
      '深色换图',
      { 'panel-corner': { src: 'u/p', dark: 'u/d' } },
      [':root.dark{--enso-asset-panel-corner:url("u/d")}'],
    ],
    [
      '会话级槽位跟 data-enso-session',
      { 'composer-peek': { src: 'u/p', states: { waiting: 'u/q' } } },
      [':root[data-enso-session="waiting"]{--enso-asset-composer-peek:url("u/q")}'],
    ],
    [
      '全局槽位跟 data-enso-activity',
      { 'sidebar-footer': { src: 'u/p', states: { error: 'u/e' } } },
      [':root[data-enso-activity="error"]{--enso-asset-sidebar-footer:url("u/e")}'],
    ],
    [
      '思考块不在进行时用静帧',
      { thinking: { src: 'u/b', still: 'u/s' } },
      [
        '--enso-asset-thinking-still:url("u/s")',
        '[data-enso="thinking"]:not([data-live])::before{background-image:var(--enso-asset-thinking-still,var(--enso-asset-thinking))}',
      ],
    ],
    ['地址里的引号和反斜杠被编码', { welcome: { src: 'u/"x\\' } }, ['url("u/%22x%5C")']],
  ])('%s', (_label, assets, fragments) => {
    const css = themeAssetsCss(assets);
    for (const fragment of fragments) expect(css).toContain(fragment);
  });

  it('状态图排在深色和静帧之后，优先生效', () => {
    const css = themeAssetsCss({
      welcome: { src: 'u/w', still: 'u/s', dark: 'u/d', states: { running: 'u/r' } },
    });
    const state = css.indexOf('[data-enso-session="running"]');
    expect(state).toBeGreaterThan(css.indexOf(':root.dark{'));
    expect(state).toBeGreaterThan(css.indexOf('@media (prefers-reduced-motion'));
  });

  it('只生成用到的槽位', () => {
    const css = themeAssetsCss({ 'code-corner': { src: 'u/c' } });
    expect(css).toContain('[data-enso="code-block"]::after');
    expect(css).not.toContain('thinking');
  });
});
