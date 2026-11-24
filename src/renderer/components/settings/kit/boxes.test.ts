import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { findNestedBoxes, isBoxedClassName } from './boxes';

describe('isBoxedClassName', () => {
  it.each([
    ['rounded-md border', true],
    ['divide-y rounded-lg border px-3', true],
    ['bg-card p-4', true],
    ['rounded-[10px] border-2', true],
    ['border-b py-3', false],
    ['rounded-md bg-muted/40 px-3', false],
    ['hover:border rounded-md', false],
    ['rounded-none border', false],
    ['', false],
  ])('%s → %s', (className, boxed) => {
    expect(isBoxedClassName(className)).toBe(boxed);
  });
});

describe('findNestedBoxes', () => {
  const dom = (html: string) => parseHTML(`<div id="r">${html}</div>`).document.getElementById('r');

  it('页面内的带框容器都算第二层卡片', () => {
    const root = dom('<section class="divide-y rounded-md border"><p>a</p></section>');
    expect(findNestedBoxes(root as unknown as Element)).toHaveLength(1);
  });

  it('控件自带的边框不算卡片', () => {
    const root = dom(
      '<input class="rounded-md border"><button class="rounded-md border"></button><kbd class="rounded border"></kbd><span data-slot="input-control" class="rounded-lg border"></span>'
    );
    expect(findNestedBoxes(root as unknown as Element)).toEqual([]);
  });

  it('ui Card 一律算卡片', () => {
    const root = dom('<div data-slot="card"></div>');
    expect(findNestedBoxes(root as unknown as Element)).toHaveLength(1);
  });

  it('预览对象本身可以有框，但里面不能再套框', () => {
    const ok = dom('<div data-settings-preview class="rounded-md border"><img></div>');
    expect(findNestedBoxes(ok as unknown as Element)).toEqual([]);
    const bad = dom(
      '<div data-settings-preview class="rounded-md border"><div class="rounded border"></div></div>'
    );
    expect(findNestedBoxes(bad as unknown as Element)).toHaveLength(1);
  });
});
