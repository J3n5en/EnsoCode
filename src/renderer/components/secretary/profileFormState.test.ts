import type { SecretaryProfile } from '@shared/types/secretary';
import { describe, expect, it } from 'vitest';
import {
  defaultDraft,
  draftFromProfile,
  formReducer,
  initialFormState,
  isLastStep,
} from './profileFormState';

const profile: SecretaryProfile = {
  version: 1,
  name: '小安',
  avatar: { color: '#123456', imageVersion: 3 },
  model: { providerId: 'p', modelId: 'm', thinkingLevel: 'high' },
  autonomy: 'tell-after',
  autoApproveProjectIds: ['p1'],
  takeoverScope: { mode: 'projects', projectIds: ['p1'] },
  visibleProjectIds: ['p1', 'p2'],
  dispatchModel: { mode: 'fixed', model: { providerId: 'p', modelId: 'm2' } },
  dispatchWorktree: 'always',
  maxRunningDispatches: 5,
  patrolEnabled: true,
  patrolIntervalMinutes: 15,
  dispatchMuted: true,
  dispatchUnattended: true,
  addressAs: '老板',
  replyLanguage: 'zh',
  style: 'detailed',
  notify: 'with-done',
  dailyBriefAt: '09:00',
  updatedAt: 1,
};

describe('defaultDraft', () => {
  it('按设计稿默认值补齐，模型跟随全局默认', () => {
    const draft = defaultDraft('Secretary');
    expect(draft).toMatchObject({
      name: 'Secretary',
      model: null,
      autonomy: 'ask-first',
      autoApproveProjectIds: [],
      visibleProjectIds: 'all',
      dispatchModel: { mode: 'project' },
      dispatchWorktree: 'auto',
      maxRunningDispatches: 3,
      replyLanguage: 'ui',
      style: 'concise',
      notify: 'needs-user',
      addressAs: null,
      dailyBriefAt: null,
    });
    expect(draft.avatar?.color).toMatch(/^#[0-9a-f]{6}$/u);
  });
});

describe('draftFromProfile', () => {
  it('没有档案时与默认草案一致', () => {
    expect(draftFromProfile(null, 'Secretary')).toEqual(defaultDraft('Secretary'));
  });

  it('已有档案时逐字段覆盖，可选字段缺省写成 null', () => {
    expect(draftFromProfile(profile, 'Secretary')).toMatchObject({
      name: '小安',
      avatar: { color: '#123456', imageVersion: 3 },
      model: { providerId: 'p', modelId: 'm', thinkingLevel: 'high' },
      autonomy: 'tell-after',
      autoApproveProjectIds: ['p1'],
      visibleProjectIds: ['p1', 'p2'],
      dispatchModel: { mode: 'fixed', model: { providerId: 'p', modelId: 'm2' } },
      dispatchWorktree: 'always',
      maxRunningDispatches: 5,
      addressAs: '老板',
      replyLanguage: 'zh',
      style: 'detailed',
      notify: 'with-done',
      dailyBriefAt: '09:00',
    });
  });

  it('名字是空白时用当前语言的默认名，而不是存一个空名字', () => {
    expect(draftFromProfile({ ...profile, name: '   ' }, 'Secretary').name).toBe('Secretary');
  });
});

describe('formReducer', () => {
  const start = initialFormState(defaultDraft('Secretary'));

  it('从第一步开始，next 逐级前进，最后一步不再前进', () => {
    expect(start.step).toBe('identity');
    const second = formReducer(start, { type: 'next' });
    expect(second.step).toBe('model');
    const third = formReducer(second, { type: 'next' });
    expect(third.step).toBe('workflow');
    expect(formReducer(third, { type: 'next' }).step).toBe('workflow');
    expect(isLastStep(third.step)).toBe(true);
  });

  it('back 在第一步原地不动，goto 直接跳到指定步骤', () => {
    expect(formReducer(start, { type: 'back' }).step).toBe('identity');
    const third = formReducer(start, { type: 'goto', step: 'workflow' });
    expect(third.step).toBe('workflow');
    expect(formReducer(third, { type: 'back' }).step).toBe('model');
  });

  it('patch 只改给出的字段', () => {
    const next = formReducer(start, { type: 'patch', patch: { name: '阿秘' } });
    expect(next.draft.name).toBe('阿秘');
    expect(next.draft.maxRunningDispatches).toBe(3);
    expect(next.step).toBe('identity');
  });

  it('patch 头像颜色时保留图片版本，否则改个颜色就把上传的头像弄丢了', () => {
    const seeded = formReducer(start, { type: 'reset', draft: draftFromProfile(profile, 'S') });
    const next = formReducer(seeded, { type: 'patch', patch: { avatar: { color: '#000000' } } });
    expect(next.draft.avatar).toEqual({ color: '#000000', imageVersion: 3 });
  });

  it('reset 换掉草案并回到第一步', () => {
    const third = formReducer(start, { type: 'goto', step: 'workflow' });
    const next = formReducer(third, { type: 'reset', draft: draftFromProfile(profile, 'S') });
    expect(next.step).toBe('identity');
    expect(next.draft.name).toBe('小安');
  });
});
