export type Locale = 'en' | 'zh';

export const zhTranslations: Record<string, string> = {
  'Add to favorites': '添加收藏',
  Appearance: '外观',
  'Bold font weight': '粗体字重',
  'Choose interface theme': '选择界面主题',
  'Color scheme': '配色方案',
  Dark: '深色',
  'Electron multi-window scaffold': 'Electron 多窗口脚手架',
  Font: '字体',
  'Font size': '字号',
  'Font weight': '字重',
  General: '通用',
  'General application settings': '应用通用设置',
  Language: '语言',
  Light: '浅色',
  'No favorite themes yet. Click the heart icon to add favorites.':
    '暂无收藏主题。点击爱心图标添加收藏。',
  'No themes found': '未找到主题',
  Preview: '预览',
  'Remove from favorites': '取消收藏',
  'Search themes...': '搜索主题...',
  Settings: '设置',
  'Show favorites only': '只显示收藏',
  'Sync terminal theme': '同步终端主题',
  System: '系统',
  Terminal: '终端',
  'Terminal appearance': '终端外观',
  'Theme mode': '主题模式',
};

export function normalizeLocale(input?: string): Locale {
  if (!input) return 'en';
  return input.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function getTranslation(locale: Locale, key: string): string {
  if (locale === 'zh') {
    return zhTranslations[key] ?? key;
  }
  return key;
}

export function translate(
  locale: Locale,
  key: string,
  params?: Record<string, string | number>
): string {
  const template = getTranslation(locale, key);
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, token) => {
    const value = params[token];
    return value === undefined ? match : String(value);
  });
}
