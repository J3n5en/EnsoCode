import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { type ChatHost, ChatHostContext } from './chatHost';
import { TimelineRow } from './TimelineRow';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: object) => unknown) => select({}),
}));
vi.mock('@/stores/sessions', () => ({ useSessionsStore: () => null }));
vi.mock('./Markdown', () => ({ Markdown: () => null }));
vi.mock('./EditDiff', () => ({ EditDiff: () => null }));
vi.mock('./ReadFileView', () => ({ ReadFileView: () => null }));

const item: TimelineItem = {
  kind: 'user',
  key: '0',
  images: [],
  text: '<routine title="晨报">读 &lt;report&gt;</routine>',
};
const render = (host: ChatHost | null) =>
  renderToStaticMarkup(
    createElement(ChatHostContext.Provider, { value: host }, createElement(TimelineRow, { item }))
  );

describe('Bot injected messages', () => {
  it('Code / 普通远程视图不解释 Bot 标签', () => {
    for (const host of [null, { sessionId: 'remote', canRewind: false, canRetry: false }]) {
      const html = render(host);
      expect(html).not.toContain('data-bot-injection');
      expect(html).toContain('&lt;routine');
    }
  });
  it('Bot 发言人或只读 Bot 会话显示卡片，正文安全地解码为文本', () => {
    for (const extra of [{ speaker: { name: '林', color: 'red' } }, { botSession: true }]) {
      const html = render({ sessionId: 'bot', canRewind: false, canRetry: false, ...extra });
      expect(html).toContain('data-bot-injection="routine"');
      expect(html).toContain('晨报');
      expect(html).toContain('读 &lt;report&gt;');
      expect(html).not.toContain('&lt;routine');
    }
  });
});
