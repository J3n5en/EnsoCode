import type { SerializedDockview } from 'dockview-react';

type GridNode = {
  type?: unknown;
  data?: unknown;
  size?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function keepPanel(id: string, panel: unknown, known: ReadonlySet<string>): boolean {
  if (!isRecord(panel)) return false;
  const kind =
    typeof panel.contentComponent === 'string'
      ? panel.contentComponent
      : typeof panel.component === 'string'
        ? panel.component
        : undefined;
  if (kind && known.has(kind)) return true;
  return id === 'browser' || id.startsWith('browser:');
}

function sanitizeNode(node: unknown, keep: ReadonlySet<string>): GridNode | undefined {
  if (!isRecord(node)) return undefined;
  if (node.type === 'leaf') {
    const data = isRecord(node.data) ? node.data : undefined;
    const views = Array.isArray(data?.views)
      ? data.views.filter((id): id is string => typeof id === 'string' && keep.has(id))
      : [];
    if (views.length === 0) return undefined;
    const original = data?.views as unknown[];
    const at = original.indexOf(data?.activeView);
    const activeView =
      typeof data?.activeView === 'string' && keep.has(data.activeView)
        ? data.activeView
        : ([...original.slice(0, Math.max(at, 0)).reverse(), ...original.slice(at + 1)].find(
            (id): id is string => typeof id === 'string' && keep.has(id)
          ) ?? views[0]);
    return {
      type: 'leaf',
      data: { ...data, views, activeView },
      size: node.size,
    };
  }
  if (node.type === 'branch') {
    const children = Array.isArray(node.data)
      ? node.data.flatMap((child) => {
          const next = sanitizeNode(child, keep);
          return next ? [next] : [];
        })
      : [];
    if (children.length === 0) return undefined;
    return { type: 'branch', data: children, size: node.size };
  }
  return undefined;
}

export function sanitizeSidePanelLayout(
  layout: unknown,
  knownComponents: ReadonlySet<string>
): SerializedDockview | undefined {
  return filterLayout(layout, (id, panel) => keepPanel(id, panel, knownComponents));
}

/** 从已存布局里摘掉一个面板（没挂载的会话同步全局关闭用）；不含该面板时原样返回 */
export function removeLayoutPanel(
  layout: SerializedDockview | undefined,
  panelId: string
): SerializedDockview | undefined {
  if (!layout || !isRecord(layout.panels) || !(panelId in layout.panels)) return layout;
  return filterLayout(layout, (id) => id !== panelId);
}

function filterLayout(
  layout: unknown,
  keepEntry: (id: string, panel: unknown) => boolean
): SerializedDockview | undefined {
  if (!isRecord(layout) || !isRecord(layout.panels)) return undefined;
  const panels: Record<string, unknown> = {};
  for (const [id, panel] of Object.entries(layout.panels)) {
    if (keepEntry(id, panel)) panels[id] = panel;
  }
  const keep = new Set(Object.keys(panels));
  if (keep.size === 0) return undefined;
  const grid = isRecord(layout.grid) ? layout.grid : undefined;
  const root = grid ? sanitizeNode(grid.root, keep) : undefined;
  if (!root) return undefined;
  return {
    ...layout,
    panels,
    grid: { ...grid, root },
  } as SerializedDockview;
}
