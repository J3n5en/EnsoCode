/**
 * 设置页头像上传的状态机：选图 → 读成 data URL → 裁切 → 保存。
 *
 * 两条硬约束，都是「连续换图第二次不生效」踩出来的：
 * - 每次选图都从干净状态重来，上一次的弹窗、错误、忙碌不带过来；
 * - 任何一步失败都清掉待裁切的图，不留半成品，也不污染下一次。
 */

export type AvatarUploadProblem = 'type' | 'size' | 'read' | 'save';

export interface AvatarUploadState {
  /** 待裁切的 data URL；null 表示裁切弹窗关着 */
  cropSource: string | null;
  busy: boolean;
  problem: AvatarUploadProblem | null;
}

export const IDLE_AVATAR_UPLOAD: AvatarUploadState = {
  cropSource: null,
  busy: false,
  problem: null,
};

export type AvatarUploadEvent =
  | { type: 'pick'; problem: 'type' | 'size' | null }
  | { type: 'picked'; source: string }
  | { type: 'read-failed' }
  | { type: 'crop-cancelled' }
  | { type: 'cropped'; tooLarge: boolean }
  | { type: 'saving' }
  | { type: 'saved' }
  | { type: 'save-failed' };

export function avatarUpload(
  state: AvatarUploadState,
  event: AvatarUploadEvent
): AvatarUploadState {
  switch (event.type) {
    // 选图先关掉上一次的弹窗：读文件失败也不会把旧图留在屏幕上
    case 'pick':
      return { ...state, cropSource: null, busy: false, problem: event.problem };
    case 'picked':
      return { cropSource: event.source, busy: false, problem: null };
    case 'read-failed':
      return { cropSource: null, busy: false, problem: 'read' };
    case 'crop-cancelled':
      return { cropSource: null, busy: false, problem: null };
    case 'cropped':
      return event.tooLarge
        ? { cropSource: null, busy: false, problem: 'size' }
        : { cropSource: null, busy: true, problem: null };
    // 移除图片也走同一条保存路径，同样先关弹窗、置忙
    case 'saving':
      return { cropSource: null, busy: true, problem: null };
    case 'saved':
      return IDLE_AVATAR_UPLOAD;
    case 'save-failed':
      return { cropSource: null, busy: false, problem: 'save' };
  }
}
