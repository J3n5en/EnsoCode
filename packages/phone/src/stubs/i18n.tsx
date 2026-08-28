import { translate } from '@shared/i18n';

/**
 * `@/i18n` 的 PWA 桩：桌面版从 zustand 取语言，这里跟随系统。
 * 经 vite alias 注入，复用桌面聊天组件时无需改动它们。
 */

const locale: 'zh' | 'en' = navigator.language.startsWith('zh') ? 'zh' : 'en';

export function useI18n() {
  return {
    locale,
    t: (key: string, params?: Record<string, string | number>) => translate(locale, key, params),
    tNode: (key: string, params?: Record<string, React.ReactNode>) => {
      const template = translate(locale, key);
      if (!params) return template;
      // 与桌面同语义：{{token}} 替换成 ReactNode
      const parts = template.split(/(\{\{\w+\}\})/g);
      return parts.map((part) => {
        const match = /^\{\{(\w+)\}\}$/.exec(part);
        if (!match) return part;
        const value = params[match[1]];
        return value === undefined ? part : <span key={match[1]}>{value}</span>;
      });
    },
  };
}
