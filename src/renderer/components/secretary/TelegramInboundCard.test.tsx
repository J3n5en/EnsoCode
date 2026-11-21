import { type Locale, translate } from '@shared/i18n';
import {
  parseInboundMessage,
  TELEGRAM_INBOUND,
  wrapInboundMessage,
} from '@shared/secretary/inbound';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TelegramInboundCard } from './TelegramInboundCard';

const h = vi.hoisted(() => ({ locale: 'zh' as Locale }));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => translate(h.locale, key, params),
    locale: h.locale,
  }),
}));
vi.mock('@/components/chat/Markdown', () => ({
  Markdown: ({ text }: { text: string }) => <div data-markdown>{text}</div>,
}));

function render(text: string): string {
  const message = parseInboundMessage(text);
  if (!message) throw new Error('不是入站消息');
  return renderToStaticMarkup(<TelegramInboundCard message={message} />);
}

describe('TelegramInboundCard', () => {
  it('显示发送者与时间，默认收起', () => {
    const html = render(
      wrapInboundMessage(TELEGRAM_INBOUND, 'zh', {
        senderName: '@jas0n_Ng',
        at: new Date(2026, 4, 20, 14, 32).getTime(),
        text: '现在你还缺少什么能力呢？',
      })
    );
    expect(html).toContain('data-telegram-inbound="telegram"');
    expect(html).toContain('来自 Telegram');
    expect(html).toContain('@jas0n_Ng');
    expect(html).toContain('14:32');
    expect(html).toContain('<details');
    expect(html).not.toContain('open=""');
  });

  it('正文按 markdown 渲染，不露包裹层与标签', () => {
    const html = render(
      wrapInboundMessage(TELEGRAM_INBOUND, 'zh', {
        senderName: '@j3n5en',
        text: '**重点**\n\n- 第一条\n- 第二条',
      })
    );
    expect(html).toContain('data-markdown');
    expect(html).toContain('**重点**');
    expect(html).not.toContain('untrusted-content');
    expect(html).not.toContain('用户本人从手机发来');
  });

  it('收起的预览只取第一行', () => {
    const html = render(
      wrapInboundMessage(TELEGRAM_INBOUND, 'zh', { text: '## 标题行\n\n正文在这里' })
    );
    const summary = html.slice(html.indexOf('<summary'), html.indexOf('</summary>'));
    expect(summary).toContain('标题行');
    expect(summary).not.toContain('正文在这里');
  });

  it('随消息落盘的图片显示成标签，收不下的显示成提示', () => {
    const html = render(
      wrapInboundMessage(TELEGRAM_INBOUND, 'zh', {
        text: '看图',
        images: [{ path: '/u/bot-chats/secretary-images/c/a.png' }, { rejected: 'not-image' }],
      })
    );
    expect(html).toContain('图片 1');
    expect(html).toContain('图片 2 未收下：不是 png / jpeg / webp / gif 图片，没有保存');
    expect(html).not.toContain('[图片');
  });
});
