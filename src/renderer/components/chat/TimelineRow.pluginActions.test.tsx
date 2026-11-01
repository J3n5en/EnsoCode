import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerPluginSlot, resetPluginSlots } from '@/plugins/registry';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { TimelineRow } from './TimelineRow';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: object) => unknown) => select({}),
}));
const sessions = { activeId: 's1', conversations: { s1: { id: 's1' } } };
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: (select: (state: object) => unknown) => select(sessions),
}));
vi.mock('./Markdown', () => ({ Markdown: () => null }));

afterEach(() => resetPluginSlots());

const item: Extract<TimelineItem, { kind: 'text' }> = {
  kind: 'text',
  key: '3-0',
  text: 'hello',
  streaming: false,
};

describe('message.action 挂点', () => {
  it('left 渲染在复制按钮之前，right 渲染在复制按钮之后', () => {
    for (const position of ['left', 'right'] as const)
      registerPluginSlot({
        pluginId: 'a.b',
        slot: 'message.action',
        position,
        component: (props) =>
          createElement('i', { 'data-plugin-action': props.position }, String(props.text)),
      });
    const html = renderToStaticMarkup(createElement(TimelineRow, { item }));
    const left = html.indexOf('data-plugin-action="left"');
    const copy = html.indexOf('title="Copy"');
    const right = html.indexOf('data-plugin-action="right"');
    expect(left).toBeGreaterThan(-1);
    expect(copy).toBeGreaterThan(left);
    expect(right).toBeGreaterThan(copy);
  });

  it('组件拿到消息下标和当前会话 id', () => {
    const seen: Record<string, unknown>[] = [];
    registerPluginSlot({
      pluginId: 'a.b',
      slot: 'message.action',
      position: 'right',
      component: (props) => {
        seen.push(props);
        return null;
      },
    });
    renderToStaticMarkup(createElement(TimelineRow, { item }));
    expect(seen[0]).toEqual({ position: 'right', text: 'hello', messageIndex: 3, sessionId: 's1' });
  });
});
