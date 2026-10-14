import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SettingsModule from './index';
import { mergeSettingsState } from './migrate';

const disk = vi.hoisted(() => ({ value: null as unknown }));
vi.stubGlobal('navigator', { language: 'en-US' });
vi.stubGlobal('document', {
  documentElement: {
    dataset: {},
    lang: 'en',
    classList: { toggle: vi.fn() },
    style: { setProperty: vi.fn(), removeProperty: vi.fn() },
  },
});
const writeKey = vi.fn(async (_key: string, value: unknown) => {
  disk.value = { 'enso-settings': value };
  return true;
});
vi.stubGlobal('window', {
  matchMedia: () => ({ matches: false, addEventListener: vi.fn() }),
  electronAPI: {
    settings: { read: vi.fn(async () => disk.value), writeKey, onChanged: vi.fn() },
    sourceAuthority: {
      read: vi.fn(async () => ({ projects: [], conversations: [] })),
      onChanged: vi.fn(() => vi.fn()),
    },
    instructions: { delete: vi.fn(async () => ({ ok: true })) },
  },
});

let settings: typeof SettingsModule;
const normalizableRules = [
  { extension: ' MD ', target: 'internal' },
  { extension: '.TXT', target: 'system' },
];
const invalidRules = [
  ...normalizableRules,
  { extension: '../exe', target: 'application', applicationPath: 'bad --arg' },
  null,
];
const cleanRules = [
  { extension: '.md', target: 'internal' },
  { extension: '.txt', target: 'system' },
];

beforeAll(async () => {
  settings = await import('./index');
  await settings.useSettingsStore.persist.rehydrate();
});
beforeEach(() => {
  settings.useSettingsStore.setState({ fileOpenRules: [] });
  writeKey.mockClear();
});

describe('fileOpenRules 设置', () => {
  it('默认空规则，并在 setter 处规范化脏输入', () => {
    const state = settings.useSettingsStore.getState();
    expect(state.fileOpenRules).toEqual([]);
    expect(typeof state.setFileOpenRules).toBe('function');
    state.setFileOpenRules(normalizableRules);
    expect(settings.useSettingsStore.getState().fileOpenRules).toEqual(cleanRules);
    state.setFileOpenRules(invalidRules);
    expect(settings.useSettingsStore.getState().fileOpenRules).toEqual([]);
  });

  it('持久化保存规则，重新水合后设置仍可见且脏磁盘规则归一化', async () => {
    const state = settings.useSettingsStore.getState();
    expect(typeof state.setFileOpenRules).toBe('function');
    state.setFileOpenRules(cleanRules);
    expect(writeKey).toHaveBeenLastCalledWith(
      'enso-settings',
      expect.objectContaining({ state: expect.objectContaining({ fileOpenRules: cleanRules }) })
    );
    settings.useSettingsStore.setState({ fileOpenRules: [] });
    disk.value = { 'enso-settings': { state: { fileOpenRules: normalizableRules }, version: 16 } };
    await settings.useSettingsStore.persist.rehydrate();
    expect(settings.useSettingsStore.getState().fileOpenRules).toEqual(cleanRules);
    disk.value = { 'enso-settings': { state: { fileOpenRules: invalidRules }, version: 16 } };
    await settings.useSettingsStore.persist.rehydrate();
    expect(settings.useSettingsStore.getState().fileOpenRules).toEqual([]);
  });

  it('merge 对同版本外部输入归一化，并为旧配置保留默认空规则', () => {
    const current = {
      editMode: 'apply_patch' as const,
      accentColor: 'violet' as const,
      fileOpenRules: [],
    };
    expect(mergeSettingsState({ fileOpenRules: normalizableRules }, current).fileOpenRules).toEqual(
      cleanRules
    );
    expect(mergeSettingsState({ fileOpenRules: invalidRules }, current).fileOpenRules).toEqual([]);
    expect(mergeSettingsState({}, current).fileOpenRules).toEqual([]);
  });

  it('外部删除规则键后重新读取，清除旧内存规则并回到默认', () => {
    const configured = {
      editMode: 'apply_patch' as const,
      accentColor: 'violet' as const,
      fileOpenRules: cleanRules,
    };
    expect(mergeSettingsState({}, configured).fileOpenRules).toEqual([]);
  });

  it('直接更新 state 也在 partialize 规范化，落盘不会保存脏字段', () => {
    settings.useSettingsStore.setState({ fileOpenRules: normalizableRules as never });
    expect(writeKey).toHaveBeenLastCalledWith(
      'enso-settings',
      expect.objectContaining({ state: expect.objectContaining({ fileOpenRules: cleanRules }) })
    );
    settings.useSettingsStore.setState({ fileOpenRules: invalidRules as never });
    expect(writeKey).toHaveBeenLastCalledWith(
      'enso-settings',
      expect.objectContaining({ state: expect.objectContaining({ fileOpenRules: [] }) })
    );
  });
});
