import { describe, expect, it, vi } from 'vitest';
import { removeComposerImage } from './Composer';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/settings', () => ({ useSettingsStore: () => undefined }));

describe('removeComposerImage 删除附件缩略图', () => {
  // 真实场景：先圈选元素（截图带 id、绑定 chip、不进缩略图），再贴一张标注图；
  // 点标注图的 × 删掉的却是元素截图
  it('点无 id 缩略图的删除只删它自己，不误删绑定 chip 的元素截图', () => {
    const shot = { data: 'shot', mimeType: 'image/png', id: 'el-1' };
    const note = { data: 'note', mimeType: 'image/png' };
    expect(removeComposerImage([shot, note], note)).toEqual([shot]);
  });

  it('内容相同的两张图只删点到的那一张', () => {
    const first = { data: 'same', mimeType: 'image/png' };
    const second = { data: 'same', mimeType: 'image/png' };
    const out = removeComposerImage([first, second], second);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(first);
  });
});
