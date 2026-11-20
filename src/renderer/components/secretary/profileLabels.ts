import type { SecretaryProfile } from '@shared/types/secretary';

/** 配置卡片与设置页共用同一份枚举文案，避免各写一套 */
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
