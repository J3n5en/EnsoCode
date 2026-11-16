import { describe, expect, it } from 'vitest';
import { secretaryAvatarUrl } from './localImage';

describe('秘书头像 URL', () => {
  it('版本号与图片指纹都在地址上，换图必换地址', () => {
    expect(secretaryAvatarUrl(1, 'aaaaaaaa')).toBe(
      'local-image://secretary-avatar/avatar.png?v=1&h=aaaaaaaa'
    );
    expect(secretaryAvatarUrl(2, 'aaaaaaaa')).not.toBe(secretaryAvatarUrl(1, 'aaaaaaaa'));
    // 版本号撞回同一个值（档案重来后从 1 数起）时，指纹仍然把两个地址区分开
    expect(secretaryAvatarUrl(1, 'bbbbbbbb')).not.toBe(secretaryAvatarUrl(1, 'aaaaaaaa'));
  });

  it('没有指纹时只带版本号', () => {
    expect(secretaryAvatarUrl(3)).toBe('local-image://secretary-avatar/avatar.png?v=3');
  });
});
