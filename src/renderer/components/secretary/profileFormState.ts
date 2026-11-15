import { parseProfile } from '@shared/secretary/parse';
import type { SecretaryProfile, SecretaryProfileDraft } from '@shared/types/secretary';

export const FORM_STEPS = ['identity', 'model', 'workflow'] as const;
export type FormStep = (typeof FORM_STEPS)[number];

export interface ProfileFormState {
  step: FormStep;
  draft: SecretaryProfileDraft;
}

export type ProfileFormAction =
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'goto'; step: FormStep }
  | { type: 'patch'; patch: SecretaryProfileDraft }
  | { type: 'reset'; draft: SecretaryProfileDraft };

/** 默认值只在 Main 的读盘解析里定义一次，表单不再抄一份 */
const PARSED_DEFAULTS = parseProfile({});
if (!PARSED_DEFAULTS) throw new Error('secretary default profile');
const DEFAULT_PROFILE: SecretaryProfile = PARSED_DEFAULTS;

function cloneDispatchModel(
  value: SecretaryProfile['dispatchModel']
): SecretaryProfile['dispatchModel'] {
  if (value.mode === 'fixed') return { mode: 'fixed', model: { ...value.model } };
  if (value.mode === 'choose') {
    return { mode: 'choose', candidates: value.candidates.map((model) => ({ ...model })) };
  }
  return { mode: 'project' };
}

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
    model: base.model ? { ...base.model } : null,
    autonomy: base.autonomy,
    autoApproveProjectIds: [...base.autoApproveProjectIds],
    takeoverScope:
      base.takeoverScope.mode === 'projects'
        ? { mode: 'projects', projectIds: [...base.takeoverScope.projectIds] }
        : base.takeoverScope,
    visibleProjectIds: base.visibleProjectIds === 'all' ? 'all' : [...base.visibleProjectIds],
    dispatchModel: cloneDispatchModel(base.dispatchModel),
    dispatchWorktree: base.dispatchWorktree,
    maxRunningDispatches: base.maxRunningDispatches,
    patrolEnabled: base.patrolEnabled,
    patrolIntervalMinutes: base.patrolIntervalMinutes,
    patrolIdleGoalMinutes: base.patrolIdleGoalMinutes,
    orphanTaskPatrol: base.orphanTaskPatrol,
    dispatchMuted: base.dispatchMuted,
    dispatchUnattended: base.dispatchUnattended,
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

export function initialFormState(draft: SecretaryProfileDraft): ProfileFormState {
  return { step: FORM_STEPS[0], draft };
}

export function stepIndex(step: FormStep): number {
  return FORM_STEPS.indexOf(step);
}

export function isLastStep(step: FormStep): boolean {
  return stepIndex(step) === FORM_STEPS.length - 1;
}

function stepAt(index: number): FormStep {
  return FORM_STEPS[Math.min(Math.max(index, 0), FORM_STEPS.length - 1)] as FormStep;
}

export function formReducer(state: ProfileFormState, action: ProfileFormAction): ProfileFormState {
  switch (action.type) {
    case 'next':
      return { ...state, step: stepAt(stepIndex(state.step) + 1) };
    case 'back':
      return { ...state, step: stepAt(stepIndex(state.step) - 1) };
    case 'goto':
      return { ...state, step: action.step };
    case 'patch': {
      const { avatar, ...rest } = action.patch;
      return {
        ...state,
        // 头像的图片版本不在这一步编辑，浅合并会把它弄丢
        draft: {
          ...state.draft,
          ...rest,
          ...(avatar ? { avatar: { ...state.draft.avatar, ...avatar } } : {}),
        },
      };
    }
    case 'reset':
      return initialFormState(action.draft);
  }
}
