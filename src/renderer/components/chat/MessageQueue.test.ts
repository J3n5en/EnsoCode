import { formatQuoteBlock } from '@shared/quoteBlock';
import { describe, expect, it } from 'vitest';
import {
  canEditQueuedInline,
  canSaveQueuedEdit,
  queuedAttachmentLabel,
  queuedDisplayText,
} from './queueEdit';

describe('排队消息附件编辑', () => {
  it('带图消息允许把文字清空，纯文本消息仍拒绝空内容', () => {
    expect(canSaveQueuedEdit('', 1)).toBe(true);
    expect(canSaveQueuedEdit('   ', 2)).toBe(true);
    expect(canSaveQueuedEdit('   ', 0)).toBe(false);
  });

  it('附件数量提示对编辑态和非编辑态共用', () => {
    expect(queuedAttachmentLabel(2, 'attachments')).toBe('2 attachments');
    expect(queuedAttachmentLabel(0, 'attachments')).toBeNull();
  });

  it('带引用块的排队消息：预览不露原始标签，也不进单行编辑框', () => {
    const wire = `${formatQuoteBlock({ text: 'one' })}\n追问`;
    expect(queuedDisplayText(wire)).not.toMatch(/<\/?quote/);
    expect(queuedDisplayText(wire)).toContain('> one');
    expect(canEditQueuedInline(wire)).toBe(false);
    expect(canEditQueuedInline('普通追问')).toBe(true);
  });
});
