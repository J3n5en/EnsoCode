import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  opened: [] as string[],
  conversations: {} as Record<string, { title: string }>,
}));

vi.mock('@/stores/sessions', () => ({
  useSessionsStore: (selector: (s: { conversations: unknown }) => unknown) =>
    selector({ conversations: h.conversations }),
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    locale: 'zh',
    t: (key: string) => key,
    tNode: (key: string, params?: Record<string, unknown>) => {
      const parts: unknown[] = [];
      const regex = /\{\{(\w+)\}\}/g;
      let last = 0;
      let m: RegExpExecArray | null = regex.exec(key);
      while (m) {
        if (m.index > last) parts.push(key.slice(last, m.index));
        parts.push(params?.[m[1]] ?? m[0]);
        last = m.index + m[0].length;
        m = regex.exec(key);
      }
      if (last < key.length) parts.push(key.slice(last));
      return parts;
    },
  }),
}));

vi.mock('@/stores/sessionPeek', () => ({
  openSessionPeek: (id: string) => h.opened.push(id),
}));

import { DependencyLinks } from './SecretaryDependencyLinks';

describe('DependencyLinks：依赖会话显示标题并可点击，缺失时降级短 id', () => {
  let root: Root;
  let container: HTMLElement;

  beforeEach(() => {
    h.opened = [];
    h.conversations = {};
    const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
    globalThis.window = window as unknown as Window & typeof globalThis;
    globalThis.document = window.document as unknown as Document;
    container = document.getElementById('root')!;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it('有标题时显示标题，点击后打开会话弹窗', () => {
    h.conversations = { 'dep-0000-0000': { title: '修复登录页样式' } };
    act(() => {
      root.render(<DependencyLinks ids={['dep-0000-0000']} />);
    });
    const link = container.querySelector('[data-enso="secretary-dependency-link"]');
    expect(link).toBeTruthy();
    expect(link?.textContent).toBe('修复登录页样式');
    expect(container.textContent).not.toContain('dep-0000');
    act(() => {
      (link as HTMLElement).click();
    });
    expect(h.opened).toEqual(['dep-0000-0000']);
  });

  it('会话不在 store 时降级显示 id 前 8 位', () => {
    h.conversations = {};
    act(() => {
      root.render(<DependencyLinks ids={['dep-deleted-12345678']} />);
    });
    const link = container.querySelector('[data-enso="secretary-dependency-link"]');
    expect(link?.textContent).toBe('dep-dele');
  });

  it('多个依赖各占一行，各自可点击', () => {
    h.conversations = {
      'aaaaaaaa-1111': { title: '任务甲' },
      'bbbbbbbb-2222': { title: '任务乙' },
    };
    act(() => {
      root.render(<DependencyLinks ids={['aaaaaaaa-1111', 'bbbbbbbb-2222']} />);
    });
    const links = container.querySelectorAll('[data-enso="secretary-dependency-link"]');
    expect(links.length).toBe(2);
    expect(links[0]?.textContent).toBe('任务甲');
    expect(links[1]?.textContent).toBe('任务乙');
    act(() => {
      (links[1] as HTMLElement).click();
    });
    expect(h.opened).toEqual(['bbbbbbbb-2222']);
  });
});
