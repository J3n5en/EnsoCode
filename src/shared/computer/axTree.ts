export interface AxTreeNode {
  ref: string;
  role: string;
  title?: string;
  value?: string;
  description?: string;
  enabled?: boolean;
  focused?: boolean;
  actions?: string[];
  children?: AxTreeNode[];
  bounds?: { x: number; y: number; width: number; height: number };
  /** 元素所属进程（macOS elementAt/node 返回），用于判断落点是否在目标 app 内 */
  pid?: number;
  /** 元素所在窗口号（macOS elementAt/node 返回） */
  windowId?: number;
}

const AX_EMPTY_WRAPPER_ROLES = new Set(['AXGroup', 'AXUnknown', 'AXGenericElement']);

export function axIsEmptyWrapper(node: AxTreeNode): boolean {
  return AX_EMPTY_WRAPPER_ROLES.has(node.role) && !node.title && !node.value && !node.description;
}

export function axFlattenEmptyWrappers(nodes: AxTreeNode[]): AxTreeNode[] {
  const out: AxTreeNode[] = [];
  for (const node of nodes) {
    const children = node.children ? axFlattenEmptyWrappers(node.children) : undefined;
    if (axIsEmptyWrapper(node)) {
      out.push(...(children ?? []));
      continue;
    }
    out.push(children ? { ...node, children } : node);
  }
  return out;
}

function attr(label: string, value: string | undefined): string {
  if (!value) return '';
  return ` ${label}=${JSON.stringify(value)}`;
}

/** 文本树，控件带 [ref=eN]，模型用 win.ref("e5")。 */
export function formatAxTree(nodes: AxTreeNode[], indent = 0): string {
  const pad = '  '.repeat(indent);
  const lines: string[] = [];
  for (const node of indent === 0 ? axFlattenEmptyWrappers(nodes) : nodes) {
    const flags = [node.enabled === false ? ' disabled' : '', node.focused ? ' focused' : ''].join(
      ''
    );
    const actions =
      node.actions && node.actions.length > 0 ? ` actions=${node.actions.join(',')}` : '';
    lines.push(
      `${pad}${node.role} [ref=${node.ref}]${attr('title', node.title)}${attr('value', node.value)}${attr('description', node.description)}${flags}${actions}`
    );
    if (node.children?.length) lines.push(formatAxTree(node.children, indent + 1));
  }
  return lines.join('\n');
}

export function axLineKey(line: string): string {
  return line.replace(/ \[ref=e\d+\]/g, '');
}

export function formatAxTreeDiff(previous: string, current: string): string {
  const prev = previous.split('\n').filter((line) => line.length > 0);
  const curr = current.split('\n').filter((line) => line.length > 0);
  const prevKeys = prev.map(axLineKey);
  const currKeys = curr.map(axLineKey);
  if (prevKeys.join('\n') === currKeys.join('\n')) return '(ax unchanged)';
  const n = prev.length;
  const m = curr.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from({ length: m + 1 }, () => 0)
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        prevKeys[i] === currKeys[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (prevKeys[i] === currKeys[j]) {
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`- ${prev[i]}`);
      i += 1;
    } else {
      out.push(`+ ${curr[j]}`);
      j += 1;
    }
  }
  while (i < n) {
    out.push(`- ${prev[i]}`);
    i += 1;
  }
  while (j < m) {
    out.push(`+ ${curr[j]}`);
    j += 1;
  }
  if (out.length === 0) return '(ax unchanged)';
  if (out.length > curr.length) return current;
  return `(ax diff; ${n} → ${m} lines)\n${out.join('\n')}`;
}
