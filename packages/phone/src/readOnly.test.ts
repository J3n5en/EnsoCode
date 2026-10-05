import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OutboxItem } from './botOutbox';
import { OutboxBar } from './OutboxBar';
import { readOnlyBanner, rejectionText } from './readOnly';

describe('只读设备提示', () => {
  it('host 以只读拒绝时明确提示「此设备为只读」，其他错误原样', () => {
    expect(rejectionText('read-only')).toBe('此设备为只读');
    expect(rejectionText('spawn failed')).toBe('spawn failed');
    expect(readOnlyBanner(false)).toContain('此设备为只读');
    expect(readOnlyBanner(true)).toContain('此设备为只读');
    expect(readOnlyBanner(true)).toContain('未执行');
  });

  it('离线队列里被拒的消息显示只读原因，只读时不给重试', () => {
    const item: OutboxItem = {
      deliveryId: 'd',
      chatId: 'c',
      text: 'hi',
      status: 'failed',
      error: 'read-only',
      createdAt: 1,
    };
    const render = (readOnly: boolean) =>
      renderToStaticMarkup(
        createElement(OutboxBar, { items: [item], readOnly, onRetry() {}, onDiscard() {} })
      );
    expect(render(false)).toContain('发送失败：此设备为只读');
    expect(render(false)).toContain('aria-label="重试"');
    expect(render(true)).not.toContain('aria-label="重试"');
    expect(render(true)).toContain('aria-label="删除"');
  });
});
