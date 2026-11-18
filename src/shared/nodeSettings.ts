/**
 * 远程节点界面（主窗口里的节点层与节点设置窗口）：宿主 renderer 经 rpc 隧道加载，
 * nodeId 以 hex 编进 host（标准 scheme 会把 host 转小写）。
 */
export const NODE_SETTINGS_SCHEME = 'enso-node';

export type NodeShellPage = 'main' | 'settings';

/** 壳页之后的文档：主界面以顶层文档运行（iframe 里的拖拽区不生效），宿主平台经 query 带入 */
export type NodeShellRoute =
  | { kind: 'shell'; page: NodeShellPage }
  | { kind: 'main'; platform: string };

const toHex = (text: string) =>
  [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join('');

export function nodeShellUrl(nodeId: string, page: NodeShellPage): string {
  return `${NODE_SETTINGS_SCHEME}://${toHex(nodeId)}/shell.html${page === 'main' ? '?page=main' : ''}`;
}

/** 相对壳页的主界面地址 */
export function nodeMainRendererPath(platform: string): string {
  return `r/index.html?platform=${encodeURIComponent(platform)}`;
}

export function nodeShellRoute(href: string): NodeShellRoute | null {
  const parsed = parseNodeSettingsUrl(href);
  if (!parsed) return null;
  const query = new URL(href).searchParams;
  if (parsed.path === 'shell.html') {
    return { kind: 'shell', page: query.get('page') === 'main' ? 'main' : 'settings' };
  }
  const platform = query.get('platform');
  return parsed.path === 'r/index.html' && platform ? { kind: 'main', platform } : null;
}

export function parseNodeSettingsUrl(raw: string): { nodeId: string; path: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const hex = url.hostname;
  if (url.protocol !== `${NODE_SETTINGS_SCHEME}:` || !hex || !/^(?:[0-9a-f]{2})+$/.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(hex.match(/../g)?.map((h) => Number.parseInt(h, 16)) ?? []);
  let nodeId: string;
  try {
    nodeId = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return { nodeId, path: url.pathname.replace(/^\//, '') };
}
