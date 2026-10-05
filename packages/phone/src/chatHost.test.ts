import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChatHostContext } from '@/components/chat/chatHost';
import { TimelineRow } from '@/components/chat/TimelineRow';
import { phoneChatHost } from './chatHost';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, string>) =>
      key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => vars?.[name] ?? ''),
  }),
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: object) => unknown) => select({}),
}));
vi.mock('@/stores/sessions', () => ({ useSessionsStore: () => null }));
vi.mock('@/components/chat/Markdown', () => ({ Markdown: () => null }));

const render = (text: string, bot?: { readOnly?: boolean }) =>
  renderToStaticMarkup(
    createElement(
      ChatHostContext.Provider,
      { value: phoneChatHost({ sessionId: 's', bot }) },
      createElement(TimelineRow, { item: { kind: 'user', key: '0', images: [], text } })
    )
  );

const groupTurn = [
  '<group-state>\n成员 A 正在忙\n</group-state>',
  '<group-message from="林" seq="3">看下手机端</group-message>',
  '<chat-reference id="c1" title="旧讨论" kind="direct">\nRecent messages\n[林]: hi\n</chat-reference>',
  '<routing-note>你被点名</routing-note>',
].join('\n');

describe('phoneChatHost', () => {
  it('Bot 成员会话（含只读查看过程）按桌面一样拆注入块：群状态隐藏、分派提示一行、引用聊天成标签', () => {
    for (const bot of [{}, { readOnly: true }]) {
      const html = render(groupTurn, bot);
      expect(html).toContain('data-bot-injection="group"');
      expect(html).toContain('看下手机端');
      expect(html).toContain('Dispatch hint: 你被点名');
      expect(html).toContain('旧讨论');
      expect(html).not.toContain('成员 A 正在忙');
      for (const tag of ['group-state', 'group-message', 'routing-note', 'chat-reference'])
        expect(html).not.toContain(`&lt;${tag}`);
    }
  });
  it('普通会话不解释 Bot 标签', () => {
    expect(render(groupTurn)).toContain('&lt;group-message');
  });
});
