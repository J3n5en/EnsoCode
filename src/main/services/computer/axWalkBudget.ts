export const AX_SNAPSHOT_BUDGET_MS = 1800;
/** 比走树预算宽一截，让部分树能 postMessage 回来，而不是和走树同时被 kill。 */
export const AX_WORKER_TIMEOUT_MS = 2800;
export const AX_SNAPSHOT_MAX_NODES = 80;
export const AX_SNAPSHOT_DEFAULT_DEPTH = 1;
/** ax({ root }) 子树缺省深度：比整窗快照深，节点预算不变 */
export const AX_SUBTREE_DEFAULT_DEPTH = 3;
export const AX_SNAPSHOT_MAX_CHILDREN = 24;
export const AX_MESSAGING_TIMEOUT_SEC = 0.4;

export function axWalkDecision(input: {
  startedAt: number;
  nodeCount: number;
  now?: number;
}): 'continue' | 'timeout' | 'budget' {
  if ((input.now ?? Date.now()) - input.startedAt >= AX_SNAPSHOT_BUDGET_MS) return 'timeout';
  if (input.nodeCount >= AX_SNAPSHOT_MAX_NODES) return 'budget';
  return 'continue';
}

export function axKeepPartialOnTimeout(nodeCount: number): boolean {
  return nodeCount > 0;
}

export function axNodeMatchesQuery(
  node: { role?: string; title?: string; value?: string; description?: string },
  query: { role?: string; title?: string; value?: string; description?: string }
): boolean {
  if (!(query.role || query.title || query.value || query.description)) return false;
  if (query.role && node.role !== query.role) return false;
  if (query.title && !node.title?.toLocaleLowerCase().includes(query.title.toLocaleLowerCase())) {
    return false;
  }
  if (query.value && !node.value?.includes(query.value)) return false;
  if (query.description) {
    const needle = query.description.toLocaleLowerCase();
    const blob = [node.title, node.value, node.description]
      .filter(Boolean)
      .join('\n')
      .toLocaleLowerCase();
    if (!blob.includes(needle)) return false;
  }
  return true;
}

const AX_QUERY_SKIP_EXPAND = new Set(['AXOutline', 'AXRow', 'AXCell', 'AXMenuBar']);

export function axQueryShouldExpand(role: string): boolean {
  return !AX_QUERY_SKIP_EXPAND.has(role);
}

const AX_ROWS_PRIMARY_ROLES = new Set(['AXOutline', 'AXList', 'AXTable', 'AXBrowser']);

export function axChildTraversalAttributes(input: {
  role?: string;
  hasRows?: boolean;
  hasVisibleChildren?: boolean;
}): string[] {
  const attributes: string[] = [];
  const skipChildren =
    (Boolean(input.hasRows) && AX_ROWS_PRIMARY_ROLES.has(input.role ?? '')) ||
    (Boolean(input.hasVisibleChildren) && input.role === 'AXList');
  if (!skipChildren) attributes.push('AXChildren');
  attributes.push('AXRows', 'AXContents', 'AXVisibleChildren');
  return attributes;
}

const AX_PASSTHROUGH_ROLES = new Set([
  'AXGroup',
  'AXSplitGroup',
  'AXScrollArea',
  'AXLayoutArea',
  'AXGenericElement',
  'AXSheet',
  'AXDialog',
]);

const AX_FORCE_EXPAND_ROLES = new Set([
  'AXOutline',
  'AXTable',
  'AXList',
  'AXMenu',
  'AXPopUpButton',
  'AXMenuButton',
]);

export function axNextDepth(role: string, depth: number): number {
  return AX_PASSTHROUGH_ROLES.has(role) ? depth : depth + 1;
}

export function axShouldExpand(role: string, depth: number, maxDepth: number): boolean {
  if (AX_PASSTHROUGH_ROLES.has(role) || AX_FORCE_EXPAND_ROLES.has(role)) return true;
  return depth < maxDepth;
}

export function axRowTitleFromCells(
  title: string | undefined,
  value: string | undefined,
  cells: string[]
): string | undefined {
  if (title || value) return undefined;
  const text = cells
    .map((cell) => cell.trim())
    .filter(Boolean)
    .join(' ');
  return text || undefined;
}

export function axCollectVisibleText(node: {
  title?: string;
  value?: string;
  description?: string;
  children?: Array<{
    title?: string;
    value?: string;
    description?: string;
    children?: unknown[];
  }>;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (item: typeof node, depth: number) => {
    if (depth > 4) return;
    for (const part of [item.title, item.value, item.description]) {
      const text = part?.trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push(text);
    }
    for (const child of item.children ?? []) walk(child as typeof node, depth + 1);
  };
  walk(node, 0);
  return out;
}

export function axFillEmptyRowTitle(node: {
  role?: string;
  title?: string;
  value?: string;
  description?: string;
  children?: Array<{
    title?: string;
    value?: string;
    description?: string;
    children?: unknown[];
  }>;
}): void {
  if (node.role !== 'AXRow' && node.role !== 'AXCell') return;
  if (node.title || node.value) return;
  const text = axCollectVisibleText(node).join(' ');
  if (text) node.title = text;
}
