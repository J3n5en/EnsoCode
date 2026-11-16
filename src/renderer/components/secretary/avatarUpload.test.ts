import { describe, expect, it } from 'vitest';
import { type AvatarUploadState, avatarUpload, IDLE_AVATAR_UPLOAD } from './avatarUpload';

const picked = (source: string): AvatarUploadState =>
  avatarUpload(IDLE_AVATAR_UPLOAD, { type: 'picked', source });

describe('设置页头像上传状态机', () => {
  it('连续换两张图：第二次裁切的是第二张，保存成功后回到空闲', () => {
    let state = avatarUpload(IDLE_AVATAR_UPLOAD, { type: 'pick', problem: null });
    state = avatarUpload(state, { type: 'picked', source: 'data:image/png;base64,AAA' });
    expect(state.cropSource).toBe('data:image/png;base64,AAA');
    state = avatarUpload(state, { type: 'cropped', tooLarge: false });
    expect(state).toEqual({ cropSource: null, busy: true, problem: null });
    state = avatarUpload(state, { type: 'saved' });
    expect(state).toEqual(IDLE_AVATAR_UPLOAD);

    state = avatarUpload(state, { type: 'pick', problem: null });
    state = avatarUpload(state, { type: 'picked', source: 'data:image/png;base64,BBB' });
    expect(state.cropSource).toBe('data:image/png;base64,BBB');
  });

  it('选图先关掉上一次的弹窗，并清掉上一次的错误', () => {
    const failed = avatarUpload(picked('data:image/png;base64,AAA'), {
      type: 'save-failed',
    });
    expect(failed.problem).toBe('save');
    expect(avatarUpload(failed, { type: 'pick', problem: null })).toEqual({
      cropSource: null,
      busy: false,
      problem: null,
    });
  });

  it('不合规图片被拒后，再选合规图片照常进入裁切', () => {
    const rejected = avatarUpload(IDLE_AVATAR_UPLOAD, { type: 'pick', problem: 'type' });
    expect(rejected).toEqual({ cropSource: null, busy: false, problem: 'type' });
    const next = avatarUpload(rejected, { type: 'pick', problem: null });
    expect(avatarUpload(next, { type: 'picked', source: 'data:image/png;base64,BBB' })).toEqual({
      cropSource: 'data:image/png;base64,BBB',
      busy: false,
      problem: null,
    });
  });

  it('裁切结果超限、读文件失败、保存失败都清掉待裁切的图', () => {
    expect(
      avatarUpload(picked('data:image/png;base64,AAA'), { type: 'cropped', tooLarge: true })
    ).toEqual({ cropSource: null, busy: false, problem: 'size' });
    expect(avatarUpload(picked('data:image/png;base64,AAA'), { type: 'read-failed' })).toEqual({
      cropSource: null,
      busy: false,
      problem: 'read',
    });
    expect(avatarUpload(picked('data:image/png;base64,AAA'), { type: 'save-failed' })).toEqual({
      cropSource: null,
      busy: false,
      problem: 'save',
    });
  });

  it('取消裁切不留下错误，也不留弹窗', () => {
    expect(avatarUpload(picked('data:image/png;base64,AAA'), { type: 'crop-cancelled' })).toEqual(
      IDLE_AVATAR_UPLOAD
    );
  });
});
