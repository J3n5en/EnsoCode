import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { TimelineRow } from './TimelineRow';

const h = vi.hoisted(() => ({ opened: [] as string[] }));

vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en' }),
}));
vi.mock('@/stores/settings', () => {
  const state = {
    autoCollapseTurns: false,
    projects: [],
    compactReadOnlyTools: false,
    expandLiveEdits: false,
  };
  const useSettingsStore = (select: (value: object) => unknown) => select(state);
  useSettingsStore.getState = () => state;
  return { useSettingsStore };
});
vi.mock('@/stores/sessions', () => {
  const state = {
    activeId: null,
    conversations: {},
    selectConversation: (id: string) => h.opened.push(id),
  };
  const useSessionsStore = (select: (value: object) => unknown) => select(state);
  useSessionsStore.getState = () => state;
  return { useSessionsStore };
});
vi.mock('@/stores/secretary', () => {
  const state = { secretary: { board: { todos: [] }, proposals: {} }, resolving: {} };
  const useSecretaryStore = (select: (value: object) => unknown) => select(state);
  useSecretaryStore.getState = () => state;
  return { useSecretaryStore };
});
vi.mock('./Markdown', () => ({ Markdown: ({ text }: { text: string }) => text }));

const UPDATES = [
  '<session-updates>',
  '- [goal-complete session:cc52649d] enso-code · 目标已完成',
  '<untrusted-content source="session">',
  '最后一句',
  '</untrusted-content>',
  '</session-updates>',
].join('\n');

let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  h.opened = [];
  vi.unstubAllGlobals();
});

async function mount(text: string) {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = dom.document.getElementById('root');
  if (!container) throw new Error('Missing test root');
  root = createRoot(container);
  const item = { kind: 'user', key: '0', text, images: [] } as TimelineItem;
  await act(async () => {
    root?.render(createElement(TimelineRow, { item }));
  });
  const find = (enso: string) =>
    container.querySelector(`[data-enso="${enso}"]`) as HTMLElement | null;
  const click = async (enso: string) => {
    const node = find(enso);
    if (!node) throw new Error(`Missing ${enso}`);
    await act(async () => {
      node.click();
    });
  };
  return { container, find, click };
}

describe('秘书会话更新卡片', () => {
  it('整行是展开开关，标题不再是链接样式', async () => {
    const ui = await mount(UPDATES);
    const expand = ui.find('secretary-update-expand');
    expect(expand?.getAttribute('aria-expanded')).toBe('false');
    expect(expand?.className).not.toContain('underline');
    expect(ui.container.textContent).not.toContain('最后一句');
    await ui.click('secretary-update-expand');
    expect(ui.find('secretary-update-expand')?.getAttribute('aria-expanded')).toBe('true');
    expect(ui.container.textContent).toContain('最后一句');
  });

  it('点主体只展开，不跳转会话', async () => {
    const ui = await mount(UPDATES);
    await ui.click('secretary-update-expand');
    await ui.click('secretary-update-expand');
    expect(ui.find('secretary-update-expand')?.getAttribute('aria-expanded')).toBe('false');
    expect(h.opened).toEqual([]);
  });

  it('右侧图标带 tooltip 且只跳转，不改变展开状态', async () => {
    const ui = await mount(UPDATES);
    const open = ui.find('secretary-update-open');
    expect(open?.tagName).toBe('BUTTON');
    expect(open?.getAttribute('title')).toBe('Open session');
    expect(open?.getAttribute('aria-label')).toBe('Open session');
    await ui.click('secretary-update-open');
    expect(h.opened).toEqual(['cc52649d']);
    expect(ui.find('secretary-update-expand')?.getAttribute('aria-expanded')).toBe('false');
    await ui.click('secretary-update-expand');
    await ui.click('secretary-update-open');
    expect(h.opened).toEqual(['cc52649d', 'cc52649d']);
    expect(ui.find('secretary-update-expand')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('没有详情的回传不画展开开关，没有会话的定时提醒不画跳转图标', async () => {
    const ui = await mount(
      ['<session-updates>', '- [goal-complete] 没有会话', '</session-updates>'].join('\n')
    );
    expect(ui.find('secretary-update-expand')).toBeNull();
    expect(ui.find('secretary-update-open')).toBeNull();
    expect(ui.container.textContent).toContain('没有会话');
  });
});
