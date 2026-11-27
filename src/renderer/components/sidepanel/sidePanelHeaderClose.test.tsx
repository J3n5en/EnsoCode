/** 触屏上右侧面板标题行必须一次点击就能收起/关闭：
 *  手机全屏盖住工作区时给出明确的 × 关闭；宽屏顶栏行的收纳按钮在触屏不依赖 hover。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { compile } from 'tailwindcss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SIDE_ACTIONS_EXTRA_CLASS,
  SidePanelCloseButton,
  SidePanelCollapseButton,
} from './sidePanelHeaderClose';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

type Rule = { selector: string; body: string; media: string[] };

/** 编译 markup 里出现的类名，拆成带外层 @media 的规则块 */
async function compiledRules(markup: string): Promise<Rule[]> {
  const candidates = [...markup.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/));
  const compiler = await compile('@import "tailwindcss";', {
    loadStylesheet: async () => {
      const path = fileURLToPath(import.meta.resolve('tailwindcss/index.css'));
      return { path, base: path, content: readFileSync(path, 'utf8') };
    },
  });
  const css = compiler.build(candidates).replace(/@[a-z-]+[^{};]*;/g, '');
  const out: Rule[] = [];
  const stack: string[] = [];
  let buf = '';
  for (const ch of css) {
    if (ch === '{') {
      stack.push(buf.trim());
      buf = '';
    } else if (ch === '}') {
      const head = stack.pop() ?? '';
      if (!head.startsWith('@')) {
        out.push({ selector: head, body: buf, media: stack.filter((s) => s.startsWith('@media')) });
      }
      buf = '';
    } else {
      buf += ch;
    }
  }
  return out;
}

/** 触屏（pointer: coarse、无 hover）下对这个类名生效的 display 值 */
function coarseDisplay(rules: Rule[], className: string): string | undefined {
  const escaped = className.replace(/[:/[\]]/g, (c) => `\\${c}`);
  return rules
    .filter(
      (r) =>
        r.selector.includes(`.${escaped}`) &&
        r.media.some((m) => m.includes('pointer: coarse')) &&
        !r.media.some((m) => m.includes('hover: hover'))
    )
    .map((r) => r.body.match(/display:\s*([a-z-]+)/)?.[1])
    .find(Boolean);
}

/** lucide 图标把自己的名字写进 class，按它取整串类名 */
const classOf = (markup: string, icon: string) =>
  markup.match(new RegExp(`class="([^"]*\\b${icon}\\b[^"]*)"`))?.[1] ?? '';

describe('宽屏触屏：顶栏行收纳不依赖 hover', () => {
  it('+ 与全屏所在的收纳组在触屏常显', async () => {
    const markup = `<div class="${SIDE_ACTIONS_EXTRA_CLASS}"></div>`;
    const rules = await compiledRules(markup);
    const shown = SIDE_ACTIONS_EXTRA_CLASS.split(' ').some(
      (c) => coarseDisplay(rules, c) === 'flex'
    );
    expect(shown).toBe(true);
  });

  it('收起按钮在触屏直接显示面板图标，不显示需要 hover 才换掉的「…」', async () => {
    const markup = renderToStaticMarkup(<SidePanelCollapseButton onClick={() => {}} />);
    expect(markup).toContain('aria-label="Toggle side panel"');
    const rules = await compiledRules(markup);
    const more = classOf(markup, 'lucide-ellipsis');
    const panel = classOf(markup, 'lucide-panel-right');
    expect(more.split(' ').some((c) => coarseDisplay(rules, c) === 'none')).toBe(true);
    expect(panel.split(' ').some((c) => coarseDisplay(rules, c) === 'block')).toBe(true);
  });
});

describe('关闭按钮', () => {
  let root: Root;
  let container: HTMLElement;

  beforeEach(() => {
    const dom = parseHTML('<html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = dom.document.getElementById('root') as unknown as HTMLElement;
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });

  it('带清晰的关闭语义，点一次就调用一次关闭', async () => {
    const onClick = vi.fn();
    await act(async () => root.render(<SidePanelCloseButton onClick={onClick} />));
    const button = container.querySelector(
      'button[aria-label="Close side panel"]'
    ) as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    expect(button?.getAttribute('title')).toBe('Close side panel');
    expect(button?.querySelector('svg.lucide-x')).not.toBeNull();
    button?.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
