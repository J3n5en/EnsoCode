import type { SecretaryAutonomy, SecretaryProfile } from '@shared/types/secretary';

/** 表单、配置卡片与设置页共用同一份枚举文案，避免三处各写一套 */
export const AUTONOMY_LABELS: Record<SecretaryAutonomy, string> = {
  'ask-first': 'Ask before dispatching',
  'tell-after': 'Tell me after dispatching',
  full: 'Fully autonomous',
};

export const WORKTREE_LABELS: Record<SecretaryProfile['dispatchWorktree'], string> = {
  never: 'Never an isolated worktree',
  auto: 'Secretary decides',
  always: 'Always an isolated worktree',
};

export const DISPATCH_MODEL_LABELS: Record<SecretaryProfile['dispatchModel']['mode'], string> = {
  project: 'Follow the project',
  fixed: 'Fixed model',
  choose: 'The secretary picks from candidates',
};

export const REPLY_LANGUAGE_LABELS: Record<SecretaryProfile['replyLanguage'], string> = {
  ui: 'Follow the interface language',
  zh: 'Chinese',
  en: 'English',
};

export const STYLE_LABELS: Record<SecretaryProfile['style'], string> = {
  concise: 'Concise',
  detailed: 'Detailed',
};

export const NOTIFY_LABELS: Record<SecretaryProfile['notify'], string> = {
  'needs-user': 'Only what needs you',
  'with-done': 'Include finished work',
  off: 'Off',
};
