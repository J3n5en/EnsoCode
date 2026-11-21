import type { SecretaryProfile } from '@shared/types/secretary';
import { describe, expect, it } from 'vitest';
import { defaultDraft, draftFromProfile, formReducer, freeSecretaryName } from './profileFormState';

const profile: SecretaryProfile = {
  version: 1,
  name: '小安',
  avatar: { color: '#123456', imageVersion: 3 },
  takeoverScope: { mode: 'projects', projectIds: ['p1'] },
  visibleProjectIds: ['p1', 'p2'],
  maxRunningDispatches: 5,
  patrolEnabled: false,
  addressAs: '老板',
  replyLanguage: 'zh',
  style: 'detailed',
  notify: 'with-done',
  dailyBriefAt: '09:00',
  updatedAt: 1,
};

const REMOVED = [
  'model',
  'autonomy',
  'autoApproveProjectIds',
  'dispatchModel',
  'dispatchWorktree',
  'patrolIntervalMinutes',
  'patrolIdleGoalMinutes',
  'orphanTaskPatrol',
  'dispatchMuted',
  'dispatchUnattended',
];

describe('defaultDraft', () => {
  it('按默认值补齐保留的设置项，删掉的设置项不再出现', () => {
    const draft = defaultDraft('Secretary');
    expect(draft).toMatchObject({
      name: 'Secretary',
      visibleProjectIds: 'all',
      maxRunningDispatches: 3,
      patrolEnabled: true,
      replyLanguage: 'ui',
      style: 'concise',
      notify: 'needs-user',
      addressAs: null,
      dailyBriefAt: null,
    });
    expect(draft.avatar?.color).toMatch(/^#[0-9a-f]{6}$/u);
    for (const key of REMOVED) expect(draft, key).not.toHaveProperty(key);
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
      visibleProjectIds: ['p1', 'p2'],
      maxRunningDispatches: 5,
      patrolEnabled: false,
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
  const start = defaultDraft('Secretary');

  it('patch 只改给出的字段', () => {
    const next = formReducer(start, { type: 'patch', patch: { name: '阿秘' } });
    expect(next.name).toBe('阿秘');
    expect(next.maxRunningDispatches).toBe(3);
  });

  it('patch 头像颜色时保留图片版本，否则改个颜色就把上传的头像弄丢了', () => {
    const seeded = formReducer(start, { type: 'reset', draft: draftFromProfile(profile, 'S') });
    const next = formReducer(seeded, { type: 'patch', patch: { avatar: { color: '#000000' } } });
    expect(next.avatar).toEqual({ color: '#000000', imageVersion: 3 });
  });

  it('reset 换掉草案', () => {
    const next = formReducer(start, { type: 'reset', draft: draftFromProfile(profile, 'S') });
    expect(next.name).toBe('小安');
  });
});

describe('freeSecretaryName', () => {
  it('没人用时就是原名', () => {
    expect(freeSecretaryName('秘书', ['小爱', null])).toBe('秘书');
  });

  it('名字被别的秘书占了就往后编号，比较忽略大小写与首尾空格', () => {
    expect(freeSecretaryName('秘书', [' 秘书 ', '秘书 2'])).toBe('秘书 3');
    expect(freeSecretaryName('Secretary', ['secretary'])).toBe('Secretary 2');
  });
});
