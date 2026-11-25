import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compile } from 'tailwindcss';
import { describe, expect, it } from 'vitest';

/**
 * 设置页触屏点击区至少 44px 靠 globals.css 里一条作用域规则。它必须在最终级联里赢过
 * ui 原语和页面自带的 after: 热区工具类（utilities 层），同时不能盖掉 absolute/sticky 等定位。
 */
const GLOBALS = fileURLToPath(new URL('../../styles/globals.css', import.meta.url));

type Block = { selector: string; body: string; layers: string[]; media: string[] };

/** 把编译后的 CSS 拆成规则块，记下每块外面套的 @layer / @media */
function blocks(css: string): Block[] {
  const out: Block[] = [];
  const stack: string[] = [];
  let buf = '';
  // 去掉 `@layer a, b;` 这类不带块的语句
  for (const ch of css.replace(/@[a-z-]+[^{};]*;/g, '')) {
    if (ch === '{') {
      stack.push(buf.trim());
      buf = '';
    } else if (ch === '}') {
      const head = stack.pop() ?? '';
      if (!head.startsWith('@')) {
        out.push({
          selector: head,
          body: buf,
          layers: stack.filter((s) => s.startsWith('@layer')),
          media: stack.filter((s) => s.startsWith('@media')),
        });
      }
      buf = '';
    } else {
      buf += ch;
    }
  }
  return out;
}

async function compiled(candidates: string[]) {
  const source = readFileSync(GLOBALS, 'utf8').replace(/@import "\.\/shared\.css";/, '');
  const compiler = await compile(source, {
    base: GLOBALS,
    loadStylesheet: async (id) => {
      if (id !== 'tailwindcss') throw new Error(`unexpected import ${id}`);
      const path = fileURLToPath(import.meta.resolve('tailwindcss/index.css'));
      return { path, base: path, content: readFileSync(path, 'utf8') };
    },
  });
  return blocks(compiler.build(candidates));
}

const isSettingsTarget = (b: Block) =>
  b.selector.startsWith('[data-slot="settings-page"]') && b.selector.includes('button');

describe('设置页触屏点击区', () => {
  it('热区伪元素只在触屏生效、至少 44px，且不进 @layer，盖过控件自带的 after: 工具类', async () => {
    const all = await compiled(['pointer-coarse:after:min-h-11', 'pointer-coarse:after:size-full']);
    const hit = all.find((b) => isSettingsTarget(b) && b.selector.endsWith('::after'));
    expect(hit, 'settings-page ::after rule').toBeDefined();
    expect(hit?.media.join(' ')).toContain('pointer: coarse');
    expect(hit?.layers).toEqual([]);
    expect(hit?.body).toMatch(/width:\s*max\(100%,\s*44px\)/);
    expect(hit?.body).toMatch(/height:\s*max\(100%,\s*44px\)/);
    const utility = all.find((b) => b.selector.includes('pointer-coarse\\:after\\:min-h-11'));
    expect(utility?.layers.join(' ')).toContain('utilities');
  });

  it('定位声明留在 base 层，absolute / sticky 工具类照常生效', async () => {
    const all = await compiled(['absolute', 'sticky']);
    const position = all.find((b) => isSettingsTarget(b) && !b.selector.endsWith('::after'));
    expect(position?.body).toMatch(/position:\s*relative/);
    expect(position?.layers.join(' ')).toContain('base');
    for (const cls of ['absolute', 'sticky']) {
      expect(all.find((b) => b.selector === `.${cls}`)?.layers.join(' ')).toContain('utilities');
    }
  });
});
