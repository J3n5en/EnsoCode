import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { ipcMain } from '@platform';
import type { PluginArtifactInfo } from '@shared/extensionPlugins/protocol';
import type { ExtensionPluginInstallPreview } from '@shared/extensionPlugins/types';
import { IPC_CHANNELS } from '@shared/types';
import { getDraftBroker, getExtensionPlugins } from '../services/extensionPlugins';
import { setPluginAssetResolver } from '../services/localImageProtocol';
import { remoteSenderById } from '../services/remoteRenderer/senders';
import { broadcastToRenderers } from '../services/renderers';
import { pluginProjectRoot } from './agent';

const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_VIEW_STATE_BYTES = 1024 * 1024;
const PLUGIN_ID = /^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/;
const ARTIFACT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CONFIG_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
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
const parsePluginId = (v: unknown): string | null =>
  typeof v === 'string' && v.length <= 40 && PLUGIN_ID.test(v) ? v : null;

export function parseConfigPatch(
  raw: unknown
): Record<string, string | number | boolean | null> | null {
  if (!isRecord(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length > 20) return null;
  const patch: Record<string, string | number | boolean | null> = {};
  for (const key of keys) {
    if (!CONFIG_KEY.test(key)) return null;
    const value = raw[key];
    if (value === null || typeof value === 'boolean') {
      patch[key] = value;
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return null;
      patch[key] = value;
      continue;
    }
    if (typeof value === 'string') {
      if (value.length > 4096) return null;
      patch[key] = value;
      continue;
    }
    return null;
  }
  return patch;
}

function parseArtifactId(raw: unknown): string | null {
  return typeof raw === 'string' && ARTIFACT_ID.test(raw) ? raw : null;
}

export function parsePickPathKind(raw: unknown): 'file' | 'directory' | null {
  return raw === 'file' || raw === 'directory' ? raw : null;
}

export function parseViewStatePatch(raw: unknown): Record<string, string | null> | null {
  if (!isRecord(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length > 500) return null;
  const patch: Record<string, string | null> = {};
  let bytes = 0;
  for (const key of keys) {
    if (key.length === 0 || key.length > 256 || key.includes('\0')) return null;
    const value = raw[key];
    if (value === null) patch[key] = null;
    else if (typeof value === 'string') patch[key] = value;
    else return null;
    bytes += key.length + (typeof value === 'string' ? value.length : 0);
    if (bytes > MAX_VIEW_STATE_BYTES) return null;
  }
  return patch;
}

export function listPluginArtifacts(
  plugins: { listArtifacts(pluginId?: string): PluginArtifactInfo[] },
  pluginId: unknown
): { ok: true; artifacts: PluginArtifactInfo[] } | { ok: false; error: string } {
  if (pluginId !== undefined) {
    const id = parsePluginId(pluginId);
    if (!id) return { ok: false, error: '参数不合法' };
    return { ok: true, artifacts: plugins.listArtifacts(id) };
  }
  return { ok: true, artifacts: plugins.listArtifacts(undefined) };
}

export function readPluginArtifact(
  plugins: {
    artifactInfo(id: string): PluginArtifactInfo | null;
    artifactPath(id: string): string | null;
  },
  id: unknown,
  readFile: (path: string) => Buffer
): { ok: true; info: PluginArtifactInfo; base64: string } | { ok: false; error: string } {
  const artifactId = parseArtifactId(id);
  if (!artifactId) return { ok: false, error: '参数不合法' };
  const info = plugins.artifactInfo(artifactId);
  if (!info) return { ok: false, error: '产出不存在' };
  if (info.size > MAX_ARTIFACT_BYTES) return { ok: false, error: '产出过大' };
  const path = plugins.artifactPath(artifactId);
  if (!path) return { ok: false, error: '产出不存在' };
  try {
    const bytes = readFile(path);
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) return { ok: false, error: '产出过大' };
    return { ok: true, info, base64: bytes.toString('base64') };
  } catch {
    return { ok: false, error: '产出读取失败' };
  }
}

export async function readPluginAsset(
  path: string,
  statFile: (path: string) => Promise<{ size: number }>,
  read: (path: string) => Promise<Buffer>
): Promise<{ ok: true; mime: string; base64: string } | { ok: false; error: string }> {
  try {
    const info = await statFile(path);
    if (info.size > MAX_ASSET_BYTES) return { ok: false, error: '资源过大' };
    const bytes = await read(path);
    if (bytes.byteLength > MAX_ASSET_BYTES) return { ok: false, error: '资源过大' };
    return {
      ok: true,
      mime: MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
      base64: bytes.toString('base64'),
    };
  } catch {
    return { ok: false, error: '资源读取失败' };
  }
}

export function deletePluginArtifact(
  plugins: { deleteArtifact(id: string): boolean },
  id: unknown
): { ok: boolean; error?: string } {
  const artifactId = parseArtifactId(id);
  if (!artifactId) return { ok: false, error: '参数不合法' };
  return { ok: plugins.deleteArtifact(artifactId) };
}

export function getPluginViewState(
  plugins: { viewStateGet(pluginId: string): Record<string, string> },
  pluginId: unknown
): { ok: true; state: Record<string, string> } | { ok: false; error: string } {
  const id = parsePluginId(pluginId);
  if (!id) return { ok: false, error: '参数不合法' };
  return { ok: true, state: plugins.viewStateGet(id) };
}

export function setPluginViewState(
  plugins: {
    viewStateSet(
      pluginId: string,
      patch: Record<string, string | null>
    ): { ok: boolean; error?: string };
  },
  pluginId: unknown,
  patch: unknown
): { ok: boolean; error?: string } {
  const id = parsePluginId(pluginId);
  const parsed = parseViewStatePatch(patch);
  if (!id || !parsed) return { ok: false, error: '参数不合法' };
  return plugins.viewStateSet(id, parsed);
}

export async function setPluginConfig(
  plugins: {
    setConfig(
      id: string,
      patch: Record<string, string | number | boolean | null>
    ): Promise<{ ok: boolean; error?: string }>;
  },
  id: unknown,
  patch: unknown
): Promise<{ ok: boolean; error?: string }> {
  if (!isId(id)) return { ok: false, error: '参数不合法' };
  const parsed = parseConfigPatch(patch);
  if (!parsed) return { ok: false, error: '参数不合法' };
  return plugins.setConfig(id, parsed);
}

export async function savePluginArtifact(
  plugins: {
    artifactInfo(id: string): PluginArtifactInfo | null;
    artifactPath(id: string): string | null;
  },
  id: unknown,
  choose: (name: string) => Promise<string | null>,
  copy: (from: string, to: string) => Promise<void>
): Promise<{ ok: true } | { ok: true; cancelled: true } | { ok: false; error: string }> {
  const artifactId = parseArtifactId(id);
  if (!artifactId) return { ok: false, error: '参数不合法' };
  const info = plugins.artifactInfo(artifactId);
  const source = info ? plugins.artifactPath(artifactId) : null;
  if (!info || !source) return { ok: false, error: '产出不存在' };
  const name = info.name.split(/[/\\]/).pop() || 'artifact';
  const dest = await choose(name);
  if (!dest) return { ok: true, cancelled: true };
  try {
    await copy(source, dest);
    return { ok: true };
  } catch {
    return { ok: false, error: '保存失败' };
  }
}

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
  setPluginAssetResolver((pluginId, rel) => plugins().assetPath(pluginId, rel));
  if (!wired) {
    wired = true;
    plugins().onChange(() => broadcastToRenderers(IPC_CHANNELS.EXTENSION_PLUGINS_CHANGED));
  }

  ipcMain.handle(IPC_CHANNELS.EXTENSION_PLUGINS_LIST, () => plugins().list());
  ipcMain.handle(IPC_CHANNELS.EXTENSION_PLUGINS_REGISTRY_NOTICE, () => plugins().registryNotice());
  ipcMain.handle(IPC_CHANNELS.EXTENSION_PLUGINS_DISMISS_REGISTRY_NOTICE, () => {
    plugins().dismissRegistryNotice();
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.EXTENSION_PLUGINS_STAGE_URL, (_e, url: unknown) => {
    if (typeof url !== 'string' || url.length > 2048) return { ok: false, error: '参数不合法' };
    return plugins().stage({ kind: 'url', url });
  });

  ipcMain.handle(IPC_CHANNELS.EXTENSION_PLUGINS_CHECK_UPDATES, () => plugins().checkUpdates());

  ipcMain.handle(IPC_CHANNELS.EXTENSION_PLUGINS_MARKET_LIST, (_e, refresh: unknown) =>
    plugins().marketList(refresh === true)
  );

  ipcMain.handle(
    IPC_CHANNELS.EXTENSION_PLUGINS_MARKET_STAGE,
    (_e, id: unknown, version: unknown) => {
      if (!isId(id)) return { ok: false, error: '参数不合法' };
      if (version !== undefined && (typeof version !== 'string' || version.length > 40))
        return { ok: false, error: '参数不合法' };
      return plugins().stage({ kind: 'market', id }, version);
    }
  );

  ipcMain.handle(IPC_CHANNELS.EXTENSION_PLUGINS_MARKET_SET_MIRROR, (_e, on: unknown) => {
    if (typeof on !== 'boolean') return { ok: false, error: '参数不合法' };
    plugins().setMarketChinaMirror(on);
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.EXTENSION_PLUGINS_RESTAGE, (_e, id: unknown) => {
    if (!isId(id)) return { ok: false, error: '参数不合法' };
    return plugins().restage(id);
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

  ipcMain.handle(
    IPC_CHANNELS.EXTENSION_PLUGINS_SET_CROSS_SESSION_INJECT,
    (_e, id: unknown, allowed: unknown) => {
      if (!isId(id) || typeof allowed !== 'boolean') return { ok: false, error: '参数不合法' };
      return plugins().setCrossSessionInject(id, allowed);
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
    return setPluginConfig(plugins(), id, patch);
  });

  ipcMain.handle(IPC_CHANNELS.EXTENSION_PLUGINS_LOGS, (_e, id: unknown) => {
    if (!isId(id)) return { ok: false, error: '参数不合法' };
    return plugins()
      .logs(id)
      .then((text) => ({ ok: true as const, text }));
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
        remote: remoteSenderById(e.sender.id) !== undefined,
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

  ipcMain.handle(
    IPC_CHANNELS.EXTENSION_PLUGINS_ASSET,
    async (_e, pluginId: unknown, rel: unknown) => {
      if (!isId(pluginId) || typeof rel !== 'string') return { ok: false, error: '参数不合法' };
      const path = plugins().assetPath(pluginId, rel);
      if (!path) return { ok: false, error: '资源不存在' };
      return readPluginAsset(
        path,
        (file) => stat(file),
        (file) => readFile(file)
      );
    }
  );

  ipcMain.handle(IPC_CHANNELS.EXTENSION_PLUGINS_ARTIFACTS_LIST, (_e, pluginId: unknown) =>
    listPluginArtifacts(plugins(), pluginId)
  );

  ipcMain.handle(IPC_CHANNELS.EXTENSION_PLUGINS_ARTIFACT_READ, (_e, id: unknown) =>
    readPluginArtifact(plugins(), id, (path) => readFileSync(path))
  );

  ipcMain.handle(IPC_CHANNELS.EXTENSION_PLUGINS_ARTIFACT_DELETE, (_e, id: unknown) =>
    deletePluginArtifact(plugins(), id)
  );

  ipcMain.handle(IPC_CHANNELS.EXTENSION_PLUGINS_VIEW_STATE_GET, (_e, pluginId: unknown) =>
    getPluginViewState(plugins(), pluginId)
  );

  ipcMain.handle(
    IPC_CHANNELS.EXTENSION_PLUGINS_VIEW_STATE_SET,
    (_e, pluginId: unknown, patch: unknown) => setPluginViewState(plugins(), pluginId, patch)
  );
}

export type ExtensionPluginStageResult =
  | { ok: true; preview: ExtensionPluginInstallPreview }
  | { ok: false; error: string }
  | { ok: true; cancelled: true };
