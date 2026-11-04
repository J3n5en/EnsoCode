import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTerminalThemeToApp, clearTerminalThemeFromApp, getThemeNames } from './ghosttyTheme';

const props = new Map<string, string>();
vi.stubGlobal('document', {
  documentElement: {
    classList: { toggle: () => undefined },
    style: {
      setProperty: (name: string, value: string) => props.set(name, value),
      removeProperty: (name: string) => props.delete(name),
    },
  },
});

const themeName = getThemeNames()[0];

describe('同步终端主题', () => {
  afterEach(() => props.clear());

  it('覆盖外壳用到的画布、凹陷、弱文字与卡片阴影 token', () => {
    applyTerminalThemeToApp(themeName);
    for (const name of ['--canvas', '--sunken', '--subtle-foreground', '--elevation-surface']) {
      expect(props.get(name), name).toBeTruthy();
    }
  });

  it('清除时撤掉应用写入的全部变量', () => {
    applyTerminalThemeToApp(themeName);
    expect(props.size).toBeGreaterThan(0);
    clearTerminalThemeFromApp();
    expect([...props.keys()]).toEqual([]);
  });
});
