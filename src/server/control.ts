import { isAbsolute } from 'node:path';
import { parsePluginInstallUrl } from '@shared/extensionPlugins/installUrl';

export { serveControlConnection } from '@shared/controlSocket';

const PLUGIN_ID_ACTIONS = [
  'enable',
  'disable',
  'approve',
  'reject',
  'uninstall',
  'inject-anywhere',
  'inject-current',
  'dev-on',
  'dev-off',
] as const;
const PLUGIN_TOKEN_ACTIONS = ['commit', 'discard'] as const;

export type PluginControlCommand =
  | { cmd: 'plugin'; action: 'list' }
  | { cmd: 'plugin'; action: 'notice-dismiss' }
  | { cmd: 'plugin'; action: 'check' }
  | { cmd: 'plugin'; action: 'stage'; path: string }
  | { cmd: 'plugin'; action: 'stage'; url: string }
  | { cmd: 'plugin'; action: (typeof PLUGIN_TOKEN_ACTIONS)[number]; token: string }
  | { cmd: 'plugin'; action: (typeof PLUGIN_ID_ACTIONS)[number]; id: string }
  | { cmd: 'plugin'; action: 'config-get'; id: string }
  | { cmd: 'plugin'; action: 'logs'; id: string }
  | { cmd: 'plugin'; action: 'restage'; id: string }
  | { cmd: 'plugin'; action: 'config-set'; id: string; values: Record<string, string | null> };

export type ControlCommand =
  | { cmd: 'pair' }
  | { cmd: 'devices' }
  | { cmd: 'update'; channel?: 'stable' | 'beta' }
  | { cmd: 'status' }
  | { cmd: 'revoke'; id: string }
  /** 仅 ENSO_SERVER_DEBUG=1 时 handle 里响应；伪造 applying 状态广播，截图/联调 UI 用 */
  | {
      cmd: 'debug-applying';
      stage: 'waiting-tasks' | 'installing' | 'restarting';
      busyCount?: number;
      version?: string;
    }
  | PluginControlCommand;

function parsePluginCommand(
  input: Record<string, unknown>
): PluginControlCommand | { error: string } {
  const { action } = input;
  const text = (key: string) => {
    const value = input[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  };
  if (action === 'list' || action === 'check' || action === 'notice-dismiss')
    return { cmd: 'plugin', action };
  if (action === 'config-get' || action === 'logs' || action === 'restage') {
    const id = text('id');
    return id ? { cmd: 'plugin', action, id } : { error: `plugin ${action} requires id` };
  }
  if (action === 'config-set') {
    const id = text('id');
    const { values } = input;
    const valid =
      typeof values === 'object' &&
      values !== null &&
      !Array.isArray(values) &&
      Object.values(values).every((v) => v === null || typeof v === 'string');
    if (!id || !valid) return { error: 'plugin config-set requires id and string values' };
    return { cmd: 'plugin', action, id, values: values as Record<string, string | null> };
  }
  if (action === 'stage') {
    const path = text('path');
    const url = text('url');
    if (path && url) return { error: 'plugin stage requires an absolute path or an http(s) url' };
    if (url) {
      const parsed = parsePluginInstallUrl(url);
      if (!parsed.ok) return { error: 'plugin stage url must be http or https' };
      return { cmd: 'plugin', action, url: parsed.url.href };
    }
    if (!path || !isAbsolute(path)) return { error: 'plugin stage requires an absolute path' };
    return { cmd: 'plugin', action, path };
  }
  if ((PLUGIN_TOKEN_ACTIONS as readonly unknown[]).includes(action)) {
    const token = text('token');
    if (!token) return { error: `plugin ${String(action)} requires token` };
    return { cmd: 'plugin', action: action as (typeof PLUGIN_TOKEN_ACTIONS)[number], token };
  }
  if ((PLUGIN_ID_ACTIONS as readonly unknown[]).includes(action)) {
    const id = text('id');
    if (!id) return { error: `plugin ${String(action)} requires id` };
    return { cmd: 'plugin', action: action as (typeof PLUGIN_ID_ACTIONS)[number], id };
  }
  return { error: 'unknown plugin action' };
}

export function parseControlCommand(line: string): ControlCommand | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { error: 'invalid json' };
  }
  if (!parsed || typeof parsed !== 'object') return { error: 'invalid command' };
  const cmd = (parsed as { cmd?: unknown }).cmd;
  if (cmd === 'pair' || cmd === 'devices' || cmd === 'status') return { cmd };
  if (cmd === 'update') {
    const channel = (parsed as { channel?: unknown }).channel;
    if (channel === undefined) return { cmd };
    if (channel === 'stable' || channel === 'beta') return { cmd, channel };
    return { error: 'update channel must be stable or beta' };
  }
  if (cmd === 'revoke') {
    const id = (parsed as { id?: unknown }).id;
    if (typeof id !== 'string' || !id.trim()) return { error: 'revoke requires id' };
    return { cmd, id: id.trim() };
  }
  // 调试命令只在 ENSO_SERVER_DEBUG=1 时生效（handle 里再判），这里透传
  if (cmd === 'debug-applying') {
    const stage = (parsed as { stage?: unknown }).stage;
    if (stage !== 'waiting-tasks' && stage !== 'installing' && stage !== 'restarting')
      return { error: 'debug-applying requires stage waiting-tasks|installing|restarting' };
    const busyCount = (parsed as { busyCount?: unknown }).busyCount;
    const version = (parsed as { version?: unknown }).version;
    return {
      cmd,
      stage,
      busyCount: typeof busyCount === 'number' ? busyCount : undefined,
      version: typeof version === 'string' ? version : undefined,
    };
  }
  if (cmd === 'plugin') return parsePluginCommand(parsed as Record<string, unknown>);
  return { error: 'unknown command' };
}
