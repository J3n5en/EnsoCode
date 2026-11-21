import { parseProfile } from '@shared/secretary/parse';
import type { SecretaryProfile, SecretaryProfileDraft } from '@shared/types/secretary';

export type ProfileFormAction =
  | { type: 'patch'; patch: SecretaryProfileDraft }
  | { type: 'reset'; draft: SecretaryProfileDraft };

/** 默认值只在 Main 的读盘解析里定义一次，表单不再抄一份 */
const PARSED_DEFAULTS = parseProfile({});
if (!PARSED_DEFAULTS) throw new Error('secretary default profile');
const DEFAULT_PROFILE: SecretaryProfile = PARSED_DEFAULTS;

/** 档案 → 表单草案：每个字段都写出来，提交时就是一份完整档案 */
export function draftFromProfile(
  profile: SecretaryProfile | null,
  defaultName: string
): SecretaryProfileDraft {
  const base = profile ?? DEFAULT_PROFILE;
  return {
    name: profile?.name.trim() || defaultName,
    avatar: {
      color: base.avatar.color,
      ...(base.avatar.imageVersion ? { imageVersion: base.avatar.imageVersion } : {}),
    },
    takeoverScope:
      base.takeoverScope.mode === 'projects'
        ? { mode: 'projects', projectIds: [...base.takeoverScope.projectIds] }
        : base.takeoverScope,
    visibleProjectIds: base.visibleProjectIds === 'all' ? 'all' : [...base.visibleProjectIds],
    maxRunningDispatches: base.maxRunningDispatches,
    patrolEnabled: base.patrolEnabled,
    replyLanguage: base.replyLanguage,
    style: base.style,
    notify: base.notify,
    addressAs: base.addressAs ?? null,
    dailyBriefAt: base.dailyBriefAt ?? null,
  };
}

export function defaultDraft(defaultName: string): SecretaryProfileDraft {
  return draftFromProfile(null, defaultName);
}

/** Main 不许两个秘书重名（不分大小写、去首尾空格）：默认名被占了就往后编号 */
export function freeSecretaryName(base: string, taken: readonly (string | null)[]): string {
  const used = new Set(taken.flatMap((name) => (name ? [name.trim().toLocaleLowerCase()] : [])));
  if (!used.has(base.trim().toLocaleLowerCase())) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate.toLocaleLowerCase())) return candidate;
  }
}

export function formReducer(
  draft: SecretaryProfileDraft,
  action: ProfileFormAction
): SecretaryProfileDraft {
  switch (action.type) {
    case 'patch': {
      const { avatar, ...rest } = action.patch;
      // 头像的图片版本不在表单里编辑，浅合并会把它弄丢
      return {
        ...draft,
        ...rest,
        ...(avatar ? { avatar: { ...draft.avatar, ...avatar } } : {}),
      };
    }
    case 'reset':
      return action.draft;
  }
}
