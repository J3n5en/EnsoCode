export interface PluginNoticeView {
  type: 'warning' | 'success';
  titleKey: string;
  params: Record<string, string>;
  actionKey?: string;
  pluginId: string;
}

const text = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : null);

export function describePluginNotice(raw: unknown): PluginNoticeView | null {
  if (!raw || typeof raw !== 'object') return null;
  const notice = raw as Record<string, unknown>;
  const pluginId = text(notice.pluginId);
  const name = text(notice.name);
  if (!pluginId || !name) return null;
  if (notice.kind === 'inject-denied') {
    return {
      type: 'warning',
      titleKey: '{{name}} tried to message another session and was blocked',
      params: { name },
      actionKey: 'Turn on',
      pluginId,
    };
  }
  const version = text(notice.version);
  if (!version) return null;
  if (notice.kind === 'update-needs-approval') {
    return {
      type: 'warning',
      titleKey: '{{name}} {{version}} needs new permissions',
      params: { name, version },
      actionKey: 'Review permissions',
      pluginId,
    };
  }
  if (notice.kind === 'auto-updated') {
    return {
      type: 'success',
      titleKey: '{{name}} updated to {{version}}',
      params: { name, version },
      actionKey: 'View',
      pluginId,
    };
  }
  return null;
}
