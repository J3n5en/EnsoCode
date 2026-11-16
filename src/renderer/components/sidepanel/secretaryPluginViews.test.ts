import { describe, expect, it } from 'vitest';
import type { PluginViewRef } from '../../plugins/viewBridge';
import { secretaryPluginPanelsToClose, secretaryPluginViews } from './secretaryPluginViews';

const view = (pluginId: string, id: string): PluginViewRef => ({
  pluginId,
  pluginName: pluginId,
  id,
  title: id,
  entry: 'view.html',
});

const views = [
  view('enso.github', 'github'),
  view('enso.tgclient', 'tgclient'),
  view('enso.kanban', 'kanban'),
];

describe('secretaryPluginViews', () => {
  it('只列出秘书设置里勾选了的插件页面', () => {
    expect(secretaryPluginViews(views, ['enso.github', 'enso.tgclient'])).toEqual([
      views[0],
      views[1],
    ]);
  });

  it('没勾选或档案没有 pluginIds 时一个也不列', () => {
    expect(secretaryPluginViews(views, [])).toEqual([]);
    expect(secretaryPluginViews(views, undefined)).toEqual([]);
  });

  it('勾选了但插件没启用（没有页面）时不凭空造面板', () => {
    expect(secretaryPluginViews(views, ['enso.translate'])).toEqual([]);
  });
});

describe('secretaryPluginPanelsToClose', () => {
  const panels = [
    'secretary',
    'browser',
    'plugin:enso.github:github',
    'plugin:enso.tgclient:tgclient',
  ];

  it('取消勾选后收起该插件已打开的页面，其余面板不动', () => {
    expect(secretaryPluginPanelsToClose(panels, ['enso.github'])).toEqual([
      'plugin:enso.tgclient:tgclient',
    ]);
    expect(secretaryPluginPanelsToClose(panels, [])).toEqual([
      'plugin:enso.github:github',
      'plugin:enso.tgclient:tgclient',
    ]);
  });

  it('勾选的插件页面保留', () => {
    expect(secretaryPluginPanelsToClose(panels, ['enso.github', 'enso.tgclient'])).toEqual([]);
  });

  it('档案还没加载到时不收任何面板，免得启动瞬间把恢复的布局清掉', () => {
    expect(secretaryPluginPanelsToClose(panels, null)).toEqual([]);
  });
});
