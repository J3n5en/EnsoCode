import type { PinnableSidePanelTab } from '@/stores/sidePanel';

export interface PinnedPluginView {
  pluginId: string;
  id: string;
}

export type PinnedPanelPlan =
  | { kind: 'terminal' }
  | { kind: 'changes' }
  | { kind: 'files' }
  | { kind: 'browser' }
  | { kind: 'btw' }
  | { kind: 'workflow' }
  | { kind: 'plugin'; pluginId: string; viewId: string };

// 旧布局里的终端可能是裸 UUID，也可能带曾经用过的 pinned-terminal 前缀。
export function isTerminalPanelId(id: string): boolean {
  return (
    id.startsWith('pinned-terminal:') || /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)
  );
}

export function isPluginPanelId(id: string): id is `plugin:${string}:${string}` {
  const separator = id.indexOf(':', 'plugin:'.length);
  return id.startsWith('plugin:') && separator > 'plugin:'.length && separator < id.length - 1;
}

export function pinnableTabForId(id: string): PinnableSidePanelTab | undefined {
  if (id === 'changes' || id === 'files' || id === 'workflow') return id;
  if (id === 'browser' || id.startsWith('browser:')) return 'browser';
  if (id.startsWith('btw:')) return 'btw';
  if (isPluginPanelId(id)) return id;
  if (isTerminalPanelId(id)) return 'terminal';
  return undefined;
}

function hasPanel(ids: readonly string[], match: (id: string) => boolean): boolean {
  return ids.some(match);
}

/**
 * 打开侧栏时要补哪些固定标签。每种只补一块；秘书会话不恢复普通会话专属面板。
 * 脏列表直接当成没有可恢复项。
 */
export function planPinnedPanels(input: {
  pinnedTabs: unknown;
  openPanelIds: readonly string[];
  secretary: boolean;
  workflowAvailable: boolean;
  pluginViews: readonly PinnedPluginView[];
  secretaryPluginIds: readonly string[] | null;
}): PinnedPanelPlan[] {
  if (!Array.isArray(input.pinnedTabs)) return [];
  const ids = [...input.openPanelIds];
  const plans: PinnedPanelPlan[] = [];
  for (const tab of input.pinnedTabs) {
    if (tab === 'terminal' && !input.secretary) {
      if (hasPanel(ids, isTerminalPanelId)) continue;
      plans.push({ kind: 'terminal' });
      ids.push('pinned-terminal:planned');
    } else if (tab === 'changes' && !input.secretary) {
      if (ids.includes('changes')) continue;
      plans.push({ kind: 'changes' });
      ids.push('changes');
    } else if (tab === 'files' && !input.secretary) {
      if (ids.includes('files')) continue;
      plans.push({ kind: 'files' });
      ids.push('files');
    } else if (tab === 'browser') {
      if (hasPanel(ids, (id) => id === 'browser' || id.startsWith('browser:'))) continue;
      plans.push({ kind: 'browser' });
      ids.push('browser:planned');
    } else if (tab === 'btw' && !input.secretary) {
      if (hasPanel(ids, (id) => id.startsWith('btw:'))) continue;
      plans.push({ kind: 'btw' });
      ids.push('btw:planned');
    } else if (tab === 'workflow' && input.workflowAvailable && !input.secretary) {
      if (ids.includes('workflow')) continue;
      plans.push({ kind: 'workflow' });
      ids.push('workflow');
    } else if (typeof tab === 'string' && tab.startsWith('plugin:')) {
      const view = input.pluginViews.find(
        (entry) => `plugin:${entry.pluginId}:${entry.id}` === tab
      );
      if (!view || (input.secretary && !input.secretaryPluginIds?.includes(view.pluginId)))
        continue;
      if (ids.includes(tab)) continue;
      plans.push({ kind: 'plugin', pluginId: view.pluginId, viewId: view.id });
      ids.push(tab);
    }
  }
  return plans;
}
