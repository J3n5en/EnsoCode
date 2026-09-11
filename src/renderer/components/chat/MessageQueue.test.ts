import { describe, expect, it } from 'vitest';
import { canSaveQueuedEdit, queuedAttachmentLabel } from './queueEdit';

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
});
