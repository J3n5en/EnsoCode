import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { ipcMain } from '@platform';
import type { ExtensionPluginInstallPreview } from '@shared/extensionPlugins/types';
import { IPC_CHANNELS } from '@shared/types';
import { getDraftBroker, getExtensionPlugins } from '../services/extensionPlugins';
import { broadcastToRenderers } from '../services/renderers';
import { pluginProjectRoot } from './agent';

const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 40;
const isConfigPatch = (v: unknown): v is Record<string, string | null> =>
  isRecord(v) &&
  Object.keys(v).length <= 20 &&
  Object.values(v).every((x) => x === null || typeof x === 'string');
const CALL_METHODS = [
  'command.run',
  'trigger.candidates',
  'trigger.pick',
  'renderer.call',
] as const;

let wired = false;

/** Enso 插件的管理与运行期通道；安装来源的选择在桌面壳（pick-and-stage） */
export function registerExtensionPluginHandlers(): void {
  const plugins = () => getExtensionPlugins();
  if (!wired) {
    wired = true;
    plugins().onChange(() => broadcastToRenderers(IPC_CHANNELS.EXTENSION_PLUGINS_CHANGED));
  }

  ipcMain.handle(IPC_CHANNELS.EXTENSION_PLUGINS_LIST, () => plugins().list());

  ipcMain.handle(IPC_CHANNELS.EXTENSION_PLUGINS_STAGE_URL, (_e, url: unknown) => {
    if (typeof url !== 'string' || url.length > 2048) return { ok: false, error: '参数不合法' };
    return plugins().stage({ kind: 'url', url });
  });

  ipcMain.handle(IPC_CHANNELS.EXTENSION_PLUGINS_COMMIT, (_e, token: unknown) => {
    if (typeof token !== 'string') return { ok: false, error: '参数不合法' };
    return plugins().commit(token);
  });

  ipcMain.handle(IPC_CHANNELS.EXTENSION_PLUGINS_DISCARD, (_e, token: unknown) => {
    if (typeof token !== 'string') return { ok: false };
    plugins().discard(token);
    return { ok: true };
  });

  ipcMain.handle(
    IPC_CHANNELS.EXTENSION_PLUGINS_SET_ENABLED,
    (_e, id: unknown, enabled: unknown) => {
      if (!isId(id) || typeof enabled !== 'boolean') return { ok: false, error: '参数不合法' };
      return plugins().setEnabled(id, enabled);
    }
  );

  ipcMain.handle(IPC_CHANNELS.EXTENSION_PLUGINS_APPROVE_PENDING, (_e, id: unknown) => {
    if (!isId(id)) return { ok: false, error: '参数不合法' };
    return plugins().approvePending(id);
  });

  ipcMain.handle(IPC_CHANNELS.EXTENSION_PLUGINS_REJECT_PENDING, (_e, id: unknown) => {
    if (!isId(id)) return { ok: false, error: '参数不合法' };
    return plugins().rejectPending(id);
  });

  ipcMain.handle(IPC_CHANNELS.EXTENSION_PLUGINS_UNINSTALL, async (_e, id: unknown) => {
    if (!isId(id)) return { ok: false, error: '参数不合法' };
    return plugins().uninstall(id);
  });

  ipcMain.handle(IPC_CHANNELS.EXTENSION_PLUGINS_CONFIG_GET, (_e, id: unknown) => {
    if (!isId(id)) return { ok: false, error: '参数不合法' };
    return plugins().configView(id);
  });

  ipcMain.handle(IPC_CHANNELS.EXTENSION_PLUGINS_CONFIG_SET, (_e, id: unknown, patch: unknown) => {
    if (!isId(id) || !isConfigPatch(patch)) return { ok: false, error: '参数不合法' };
    return plugins().setConfig(id, patch);
  });

  ipcMain.handle(IPC_CHANNELS.EXTENSION_PLUGINS_CALL, async (e, raw: unknown) => {
    if (
      !isRecord(raw) ||
      !isId(raw.pluginId) ||
      !(CALL_METHODS as readonly unknown[]).includes(raw.method) ||
      !isRecord(raw.payload) ||
      (raw.sessionId !== null && typeof raw.sessionId !== 'string')
    )
      return { ok: false, error: '参数不合法' };
    try {
      const value = await plugins().callUi({
        pluginId: raw.pluginId,
        method: raw.method as (typeof CALL_METHODS)[number],
        payload: raw.payload,
        sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null,
        projectRoot: typeof raw.sessionId === 'string' ? pluginProjectRoot(raw.sessionId) : null,
        origin: e.sender.id,
      });
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.EXTENSION_PLUGINS_DRAFT_RESPONSE, (e, raw: unknown) => {
    getDraftBroker().respond(e.sender.id, raw);
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.EXTENSION_PLUGINS_ASSET, (_e, pluginId: unknown, rel: unknown) => {
    if (!isId(pluginId) || typeof rel !== 'string') return { ok: false, error: '参数不合法' };
    const path = plugins().assetPath(pluginId, rel);
    if (!path) return { ok: false, error: '资源不存在' };
    try {
      const bytes = readFileSync(path);
      if (bytes.byteLength > MAX_ASSET_BYTES) return { ok: false, error: '资源过大' };
      return {
        ok: true,
        mime: MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
        base64: bytes.toString('base64'),
      };
    } catch {
      return { ok: false, error: '资源读取失败' };
    }
  });
}

export type ExtensionPluginStageResult =
  | { ok: true; preview: ExtensionPluginInstallPreview }
  | { ok: false; error: string }
  | { ok: true; cancelled: true };
