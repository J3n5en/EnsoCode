import { describe, expect, it } from 'vitest';
import { pinnableTabForId, planPinnedPanels } from './pinnedTabs';

const views = [
  { pluginId: 'notes', id: 'board' },
  { pluginId: 'mail', id: 'inbox' },
];

describe('pinnableTabForId', () => {
  it('给可固定的面板一个稳定身份，秘书面板没有图钉', () => {
    expect(pinnableTabForId('changes')).toBe('changes');
    expect(pinnableTabForId('files')).toBe('files');
    expect(pinnableTabForId('workflow')).toBe('workflow');
    expect(pinnableTabForId('browser')).toBe('browser');
    expect(pinnableTabForId('browser:abc')).toBe('browser');
    expect(pinnableTabForId('btw:abc')).toBe('btw');
    expect(pinnableTabForId('plugin:notes:board')).toBe('plugin:notes:board');
    expect(pinnableTabForId('6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('terminal');
    expect(pinnableTabForId('pinned-terminal:old')).toBe('terminal');
    expect(pinnableTabForId('secretary')).toBeUndefined();
    expect(pinnableTabForId('plugin:only')).toBeUndefined();
  });
});

describe('planPinnedPanels', () => {
  const base = {
    openPanelIds: [] as string[],
    secretary: false,
    workflowAvailable: true,
    pluginViews: views,
    secretaryPluginIds: null as readonly string[] | null,
  };

  it('按固定顺序补齐还没有的面板，同一种只补一块', () => {
    expect(
      planPinnedPanels({
        ...base,
        pinnedTabs: ['terminal', 'terminal', 'changes', 'files', 'browser', 'btw', 'workflow'],
      })
    ).toEqual([
      { kind: 'terminal' },
      { kind: 'changes' },
      { kind: 'files' },
      { kind: 'browser' },
      { kind: 'btw' },
      { kind: 'workflow' },
    ]);
  });

  it('已经打开的同类面板不再补', () => {
    expect(
      planPinnedPanels({
        ...base,
        pinnedTabs: ['terminal', 'browser', 'btw', 'changes', 'plugin:notes:board'],
        openPanelIds: [
          '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
          'browser:existing',
          'btw:existing',
          'changes',
          'plugin:notes:board',
        ],
      })
    ).toEqual([]);
  });

  it('秘书会话只补浏览器和勾选过的插件页', () => {
    expect(
      planPinnedPanels({
        ...base,
        secretary: true,
        secretaryPluginIds: ['notes'],
        pinnedTabs: [
          'terminal',
          'changes',
          'files',
          'btw',
          'workflow',
          'browser',
          'plugin:notes:board',
          'plugin:mail:inbox',
        ],
      })
    ).toEqual([{ kind: 'browser' }, { kind: 'plugin', pluginId: 'notes', viewId: 'board' }]);
  });

  it('秘书档案还没到、工作流不可用、插件视图不存在时跳过', () => {
    expect(
      planPinnedPanels({
        ...base,
        secretary: true,
        workflowAvailable: false,
        secretaryPluginIds: null,
        pinnedTabs: ['workflow', 'plugin:notes:board', 'plugin:missing:view', 'nope'],
      })
    ).toEqual([]);
  });

  it('脏的固定列表不会抛错', () => {
    expect(
      planPinnedPanels({
        ...base,
        pinnedTabs: null,
      })
    ).toEqual([]);
    expect(
      planPinnedPanels({
        ...base,
        pinnedTabs: ['files', 1, 'files'],
      })
    ).toEqual([{ kind: 'files' }]);
  });
});
