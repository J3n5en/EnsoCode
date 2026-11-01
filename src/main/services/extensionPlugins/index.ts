import { join } from 'node:path';
import { app, notification, pluginHostPath, utilityProcess } from '@platform';
import { IPC_CHANNELS } from '@shared/types';
import { rendererById } from '../renderers';
import { DraftBroker } from './draftBroker';
import type { GateDeps } from './gate';
import { pluginError } from './process';
import { ExtensionPluginService } from './service';

/** 宿主 MCP 由 agentHost 注入（经 worker 执行），避免这里反向依赖 agentHost */
export type PluginMcpBridge = Pick<GateDeps, 'mcpTools' | 'mcpCall'>;

let service: ExtensionPluginService | null = null;
let mcpBridge: PluginMcpBridge | null = null;
let draftBroker: DraftBroker | null = null;

const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'windir',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
];

/** 插件进程不继承 Main 的环境变量，只给运行 Node 必需的几项 */
export function pluginHostEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) if (source[key] !== undefined) env[key] = source[key];
  return env;
}

export function getDraftBroker(): DraftBroker {
  draftBroker ??= new DraftBroker({
    channel: IPC_CHANNELS.EXTENSION_PLUGINS_DRAFT_REQUEST,
    find: rendererById,
  });
  return draftBroker;
}

export function setPluginMcpBridge(bridge: PluginMcpBridge | null): void {
  mcpBridge = bridge;
}

const noMcp = () => Promise.reject(pluginError('UNSUPPORTED', '当前环境无法调用 MCP'));

export function getExtensionPlugins(): ExtensionPluginService {
  if (service) return service;
  service = new ExtensionPluginService({
    root: join(app.getPath('userData'), 'extension-plugins'),
    hostVersion: app.getVersion(),
    hostPath: pluginHostPath,
    env: pluginHostEnv(process.env),
    fork: (modulePath, args, options) => utilityProcess.fork(modulePath, args, options),
    gate: {
      fetch: (url, init) => fetch(url, init),
      notify: (title, body) => {
        if (!notification.isSupported()) return false;
        notification.show({ title, body });
        return true;
      },
      composer: (target, op, payload) =>
        getDraftBroker().request(target.origin, target.sessionId, op, payload),
      mcpTools: (target, signal) => (mcpBridge ? mcpBridge.mcpTools(target, signal) : noMcp()),
      mcpCall: (target, server, tool, args, signal) =>
        mcpBridge ? mcpBridge.mcpCall(target, server, tool, args, signal) : noMcp(),
      now: Date.now,
    },
  });
  app.on('before-quit', () => service?.dispose());
  return service;
}
