import { describe, expect, it, vi } from 'vitest';

vi.stubGlobal('navigator', { language: 'en-US' });
vi.stubGlobal('document', {
  documentElement: {
    dataset: {},
    lang: 'en',
    classList: { toggle: vi.fn() },
    style: { setProperty: vi.fn(), removeProperty: vi.fn() },
  },
});
vi.stubGlobal('window', {
  matchMedia: () => ({ matches: false, addEventListener: vi.fn() }),
  electronAPI: {
    settings: {
      read: vi.fn(async () => null),
      writeKey: vi.fn(async () => true),
      onChanged: vi.fn(),
    },
    sourceAuthority: {
      read: vi.fn(async () => ({ projects: [], conversations: [] })),
      onChanged: vi.fn(() => vi.fn()),
    },
    instructions: { delete: vi.fn(async () => ({ ok: true })) },
  },
});

const settings = await import('./index');

describe('Code 会话受保护动作底线设置', () => {
  it('默认关闭（Code 行为不变），可显式开启', () => {
    expect(settings.useSettingsStore.getState().protectedActionsInCode).toBe(false);
    settings.useSettingsStore.getState().setProtectedActionsInCode(true);
    expect(settings.useSettingsStore.getState().protectedActionsInCode).toBe(true);
  });
});
