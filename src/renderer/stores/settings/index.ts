import type { Locale } from '@shared/i18n';
import { normalizeLocale } from '@shared/i18n';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import {
  applyTerminalThemeToApp,
  clearTerminalThemeFromApp,
  isTerminalThemeDark,
} from '@/lib/ghosttyTheme';
import { electronStorage } from './storage';
import type { FontWeight, SettingsState, Theme } from './types';

export * from './types';

// Apply terminal font settings to app CSS variables
function applyTerminalFont(fontFamily: string, fontSize: number): void {
  const root = document.documentElement;
  root.style.setProperty('--font-family-mono', fontFamily);
  root.style.setProperty('--font-size-base', `${fontSize}px`);
}

// Apply app theme (dark/light mode)
function applyAppTheme(theme: Theme, terminalTheme: string): void {
  let isDark: boolean;

  switch (theme) {
    case 'light':
      isDark = false;
      break;
    case 'dark':
      isDark = true;
      break;
    case 'system':
      isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      break;
    case 'sync-terminal':
      isDark = isTerminalThemeDark(terminalTheme);
      break;
  }

  document.documentElement.classList.toggle('dark', isDark);
}

// Apply settings side effects (theme / font / lang) — 初次加载与多窗口同步时调用
function applySettings(state: {
  theme: Theme;
  terminalTheme: string;
  terminalFontFamily: string;
  terminalFontSize: number;
  language: Locale;
}): void {
  if (state.theme === 'sync-terminal') {
    applyTerminalThemeToApp(state.terminalTheme, true);
  } else {
    clearTerminalThemeFromApp();
    applyAppTheme(state.theme, state.terminalTheme);
  }
  applyTerminalFont(state.terminalFontFamily, state.terminalFontSize);
  document.documentElement.lang = normalizeLocale(state.language) === 'zh' ? 'zh-CN' : 'en';
}

function getDefaultLocale(): Locale {
  return normalizeLocale(navigator.language);
}

const initialState = {
  theme: 'system' as Theme,
  language: getDefaultLocale(),
  terminalTheme: 'Dracula',
  terminalFontSize: 14,
  terminalFontFamily: 'ui-monospace, SF Mono, Menlo, Monaco, Consolas, monospace',
  terminalFontWeight: 'normal' as FontWeight,
  terminalFontWeightBold: '500' as FontWeight,
  favoriteTerminalThemes: [] as string[],
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      ...initialState,

      setTheme: (theme) => {
        const terminalTheme = get().terminalTheme;
        if (theme === 'sync-terminal') {
          applyTerminalThemeToApp(terminalTheme, true);
        } else {
          clearTerminalThemeFromApp();
          applyAppTheme(theme, terminalTheme);
        }
        set({ theme });
      },

      setLanguage: (language) => {
        document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
        set({ language });
      },

      setTerminalTheme: (terminalTheme) => {
        if (get().theme === 'sync-terminal') {
          applyTerminalThemeToApp(terminalTheme, true);
        }
        set({ terminalTheme });
      },

      setTerminalFontSize: (terminalFontSize) => {
        applyTerminalFont(get().terminalFontFamily, terminalFontSize);
        set({ terminalFontSize });
      },

      setTerminalFontFamily: (terminalFontFamily) => {
        applyTerminalFont(terminalFontFamily, get().terminalFontSize);
        set({ terminalFontFamily });
      },

      setTerminalFontWeight: (terminalFontWeight) => set({ terminalFontWeight }),
      setTerminalFontWeightBold: (terminalFontWeightBold) => set({ terminalFontWeightBold }),

      toggleFavoriteTerminalTheme: (theme) =>
        set((state) => ({
          favoriteTerminalThemes: state.favoriteTerminalThemes.includes(theme)
            ? state.favoriteTerminalThemes.filter((t) => t !== theme)
            : [...state.favoriteTerminalThemes, theme],
        })),
    }),
    {
      name: 'enso-settings',
      storage: createJSONStorage(() => electronStorage),
      onRehydrateStorage: () => (state) => {
        applySettings(state ?? useSettingsStore.getState());
      },
    }
  )
);

// 跟随系统明暗变化
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  const state = useSettingsStore.getState();
  if (state.theme === 'system') {
    applyAppTheme('system', state.terminalTheme);
  }
});

// 多窗口同步：其他窗口写入设置后重新 rehydrate 本窗口 store 并应用副作用
window.electronAPI.settings.onChanged(() => {
  void useSettingsStore.persist.rehydrate();
});
