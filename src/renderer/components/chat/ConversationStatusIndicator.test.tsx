import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ConversationStatusIndicator } from './ConversationStatusIndicator';

vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en' }),
}));

describe('ConversationStatusIndicator', () => {
  it('排队是橙色闹钟，悬停写出位次', () => {
    const html = renderToStaticMarkup(
      createElement(ConversationStatusIndicator, {
        tone: 'queued',
        title: 'Queued · #2, starts automatically when a slot opens',
        conversationId: 'c1',
      })
    );
    expect(html).toContain('data-enso="conversation-queued"');
    expect(html).toContain('data-conversation-id="c1"');
    expect(html).toContain('data-tone="queued"');
    expect(html).toContain('lucide-alarm-clock');
    expect(html).toContain('Queued · #2, starts automatically when a slot opens');
  });
});
