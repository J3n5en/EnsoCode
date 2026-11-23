import { beforeEach, describe, expect, it, vi } from 'vitest';

const deleteSystemPrompt = vi.fn(async () => ({ ok: true }));
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
      writeKey: vi.fn(async () => undefined),
      onChanged: vi.fn(),
    },
    sourceAuthority: {
      read: vi.fn(async () => ({ projects: [], conversations: [] })),
      onChanged: vi.fn(() => vi.fn()),
    },
    presets: { deleteSystemPrompt },
  },
});

const settingsModule = await import('./index');
const promptId = '017f23dd-c633-4e83-b695-52236a0d828a';
const preset = (id: string, systemPromptId = promptId) => ({
  id,
  name: id,
  skillIds: [],
  mcpServerIds: [],
  systemPromptId,
});

describe('预设系统提示词文件生命周期', () => {
  beforeEach(() => {
    settingsModule.useSettingsStore.setState({
      presets: [preset('custom')],
      defaultPresetId: 'custom',
    });
    deleteSystemPrompt.mockClear();
  });

  it('删除自定义预设回落全局默认，正文交给 Main 落盘后清理', () => {
    const store = settingsModule.useSettingsStore;
    store.getState().removePreset('custom');
    expect(store.getState().presets).toEqual([]);
    expect(store.getState().defaultPresetId).toBe('default');
    expect(deleteSystemPrompt).not.toHaveBeenCalled();
  });

  it('恢复 pi 默认仅清除引用，不提前删除旧正文', () => {
    const store = settingsModule.useSettingsStore;
    store.getState().updatePreset('custom', { systemPromptId: undefined });
    expect(store.getState().presets[0].systemPromptId).toBeUndefined();
    expect(deleteSystemPrompt).not.toHaveBeenCalled();
  });

  it('仅改名字或保留同一引用时不删除正文', () => {
    const store = settingsModule.useSettingsStore;
    store.getState().updatePreset('custom', { name: 'Renamed' });
    store.getState().updatePreset('custom', { systemPromptId: promptId });
    expect(store.getState().presets[0].name).toBe('Renamed');
    expect(deleteSystemPrompt).not.toHaveBeenCalled();
  });

  it('其他预设仍引用同一正文时不误删', () => {
    const store = settingsModule.useSettingsStore;
    store.setState({ presets: [preset('custom'), preset('other')] });
    store.getState().removePreset('custom');
    expect(deleteSystemPrompt).not.toHaveBeenCalled();
    store.getState().updatePreset('other', { systemPromptId: undefined });
    expect(deleteSystemPrompt).not.toHaveBeenCalled();
  });

  it('全局预设即使出现在脏配置里也不能编辑或删除', () => {
    const store = settingsModule.useSettingsStore;
    store.setState({ presets: [preset('default')], defaultPresetId: 'default' });
    store.getState().updatePreset('default', { name: 'Changed' });
    store.getState().removePreset('default');
    expect(store.getState().presets).toEqual([preset('default')]);
    expect(deleteSystemPrompt).not.toHaveBeenCalled();
  });
});
