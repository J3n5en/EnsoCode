/** 节点设置窗口：宿主 renderer 经 rpc 隧道加载，nodeId 以 hex 编进 host（标准 scheme 会把 host 转小写） */
export const NODE_SETTINGS_SCHEME = 'enso-node';

const toHex = (text: string) =>
  [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join('');

export function nodeSettingsUrl(nodeId: string): string {
  return `${NODE_SETTINGS_SCHEME}://${toHex(nodeId)}/shell.html`;
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
