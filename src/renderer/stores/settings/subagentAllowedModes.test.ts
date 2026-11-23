import { beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('subagent allowed modes settings', () => {
  beforeEach(() => {
    settings.useSettingsStore.setState({
      disabledBuiltinTools: [],
      subagentAllowedModes: ['task', 'coworker'],
      projects: [{ id: 'project-1', name: 'one', path: '/tmp/one' }],
    });
  });

  it('does not widen the mode mask when the unified tool is disabled and re-enabled', () => {
    const store = settings.useSettingsStore.getState();
    store.setSubagentAllowedModes(['task']);
    store.toggleBuiltinTool('subagent', false);
    store.toggleBuiltinTool('subagent', true);

    expect(settings.useSettingsStore.getState().subagentAllowedModes).toEqual(['task']);
  });

  it('stores and clears a project mode override explicitly', () => {
    settings.useSettingsStore.getState().setProjectSubagentAllowedModes('project-1', ['coworker']);
    expect(settings.useSettingsStore.getState().projects[0]?.subagentAllowedModes).toEqual([
      'coworker',
    ]);

    settings.useSettingsStore.getState().setProjectDisabledBuiltinTools('project-1', ['subagent']);
    settings.useSettingsStore.getState().setProjectDisabledBuiltinTools('project-1', []);
    expect(settings.useSettingsStore.getState().projects[0]?.subagentAllowedModes).toEqual([
      'coworker',
    ]);

    settings.useSettingsStore.getState().setProjectSubagentAllowedModes('project-1', null);
    expect(settings.useSettingsStore.getState().projects[0]?.subagentAllowedModes).toBeUndefined();
  });

  it('stores and revokes trusted project code sources', () => {
    const store = settings.useSettingsStore.getState();
    store.setProjectTrustedCode('project-1', ['b', 'a', 'a']);
    expect(settings.useSettingsStore.getState().projects[0]?.trustedProjectCode).toEqual([
      'a',
      'b',
    ]);
    store.setProjectTrustedCode('project-1', null);
    expect(settings.useSettingsStore.getState().projects[0]?.trustedProjectCode).toBeUndefined();
  });
});
