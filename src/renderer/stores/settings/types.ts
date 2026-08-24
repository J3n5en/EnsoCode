import type { Locale } from '@shared/i18n';

export type Theme = 'light' | 'dark' | 'system' | 'sync-terminal';

export type FontWeight =
  | 'normal'
  | 'bold'
  | '100'
  | '200'
  | '300'
  | '400'
  | '500'
  | '600'
  | '700'
  | '800'
  | '900';

export interface SettingsState {
  // UI
  theme: Theme;
  language: Locale;

  // Terminal appearance
  terminalTheme: string;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalFontWeight: FontWeight;
  terminalFontWeightBold: FontWeight;
  favoriteTerminalThemes: string[];

  // Setters
  setTheme: (theme: Theme) => void;
  setLanguage: (language: Locale) => void;
  setTerminalTheme: (theme: string) => void;
  setTerminalFontSize: (size: number) => void;
  setTerminalFontFamily: (family: string) => void;
  setTerminalFontWeight: (weight: FontWeight) => void;
  setTerminalFontWeightBold: (weight: FontWeight) => void;
  toggleFavoriteTerminalTheme: (theme: string) => void;
}
