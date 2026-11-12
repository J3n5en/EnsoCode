import type { ExtensionPluginSummary } from '@shared/extensionPlugins/types';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/ui/toast', () => ({ addToast: vi.fn() }));

const { pluginStatusRefs } = await import('./statusItems');

const summary = (patch: Partial<ExtensionPluginSummary>) =>
  ({
    id: 'a.b',
    name: 'AB',
    state: 'enabled',
    statusItems: [],
    ...patch,
  }) as ExtensionPluginSummary;

describe('pluginStatusRefs', () => {
  it('只取已启用插件里可见且有文字的状态项', () => {
    const item = { id: 'q', text: '3', tone: 'warning' as const, visible: true };
    expect(
      pluginStatusRefs([
        summary({ statusItems: [item, { ...item, id: 'hidden', visible: false }] }),
        summary({ id: 'c.d', state: 'disabled', statusItems: [item] }),
        summary({ id: 'e.f', statusItems: [{ ...item, text: '  ' }] }),
      ])
    ).toEqual([{ ...item, pluginId: 'a.b', pluginName: 'AB' }]);
  });
});
