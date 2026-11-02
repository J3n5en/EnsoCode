import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isPluginId } from '@shared/extensionPlugins/manifest';
import { PLUGIN_STATES, type PluginRecord } from './lifecycle';

/** 插件系统上线前不做兼容：版本不符或字段不全的记录直接丢弃 */
export const REGISTRY_VERSION = 2;

export interface RegistryFile {
  version: typeof REGISTRY_VERSION;
  plugins: PluginRecord[];
}

const ID = /^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/;
const DIR = /^[A-Za-z0-9-]{1,64}$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

function isGrant(v: unknown): boolean {
  return (
    isRecord(v) &&
    isStringArray(v.permissions) &&
    isStringArray(v.fsRead) &&
    isStringArray(v.fsWrite) &&
    isStringArray(v.netDomains) &&
    typeof v.renderer === 'boolean' &&
    isStringArray(v.mcpTools) &&
    isStringArray(v.env) &&
    isStringArray(v.interop) &&
    isStringArray(v.intercepts) &&
    typeof v.resident === 'boolean' &&
    Array.isArray(v.mcp) &&
    v.mcp.every(
      (s) =>
        isRecord(s) &&
        typeof s.name === 'string' &&
        typeof s.command === 'string' &&
        isStringArray(s.args) &&
        isStringArray(s.envKeys)
    )
  );
}

function isPluginRecord(v: unknown): v is PluginRecord {
  if (!isRecord(v)) return false;
  const pendingOk =
    v.pending === undefined ||
    (isRecord(v.pending) &&
      typeof v.pending.version === 'string' &&
      typeof v.pending.dir === 'string' &&
      DIR.test(v.pending.dir) &&
      isGrant(v.pending.grant));
  return (
    typeof v.id === 'string' &&
    ID.test(v.id) &&
    typeof v.version === 'string' &&
    typeof v.dir === 'string' &&
    DIR.test(v.dir) &&
    (PLUGIN_STATES as readonly unknown[]).includes(v.state) &&
    isGrant(v.grant) &&
    typeof v.installedAt === 'number' &&
    typeof v.crossSessionInject === 'boolean' &&
    pendingOk
  );
}

export interface RegistryRead extends RegistryFile {
  /** 被丢弃且能读出合法 id 的记录 */
  discarded: string[];
  /** 文件存在但读不出（不是 JSON、形状不对）；此时不能据它推断磁盘上哪些文件是残留 */
  unreadable: boolean;
}

const registryPath = (root: string) => join(root, 'registry.json');

/** Main 私有文件，不放进 settings.json：远端渲染进程能写设置，不能让它自己给插件授权 */
export function readRegistry(root: string): RegistryRead {
  const empty = (unreadable: boolean): RegistryRead => ({
    version: REGISTRY_VERSION,
    plugins: [],
    discarded: [],
    unreadable,
  });
  let text: string;
  try {
    text = readFileSync(registryPath(root), 'utf8');
  } catch {
    return empty(existsSync(registryPath(root)));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return empty(true);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.plugins)) return empty(true);
  const list = parsed.plugins;
  const current = isRecord(parsed) && parsed.version === REGISTRY_VERSION;
  const seen = new Set<string>();
  const plugins: PluginRecord[] = [];
  const discarded: string[] = [];
  for (const item of list) {
    if (!current || !isPluginRecord(item)) {
      if (isRecord(item) && typeof item.id === 'string' && ID.test(item.id))
        discarded.push(item.id);
      continue;
    }
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const { lastError, source, ...rest } = item;
    plugins.push({
      ...rest,
      ...(lastError && isLastError(lastError) ? { lastError } : {}),
      ...(isSource(source) ? { source } : {}),
    });
  }
  return { version: REGISTRY_VERSION, plugins, discarded, unreadable: false };
}

const isLastError = (v: unknown) =>
  v === undefined || (isRecord(v) && typeof v.at === 'number' && typeof v.message === 'string');

/** 只认绝对路径、http(s) 链接与市场插件 id；其它一律当作没有记录来源 */
function isSource(v: unknown): v is NonNullable<PluginRecord['source']> {
  if (!isRecord(v)) return false;
  if (v.kind === 'dir' || v.kind === 'zip') return typeof v.path === 'string' && isAbsolute(v.path);
  if (v.kind === 'market') return isPluginId(v.id);
  return v.kind === 'url' && typeof v.url === 'string' && /^https?:\/\//i.test(v.url);
}

/** 读不出的登记表原样另存；已有一份时保留最早那份 */
export function preserveUnreadableRegistry(root: string): void {
  const target = `${registryPath(root)}.unreadable`;
  if (existsSync(target)) return;
  try {
    copyFileSync(registryPath(root), target);
  } catch {}
}

/** 原子写入；覆盖前把上一份留成 registry.json.bak */
export function writeRegistry(root: string, file: RegistryFile): void {
  mkdirSync(root, { recursive: true });
  const target = registryPath(root);
  try {
    copyFileSync(target, `${target}.bak`);
  } catch {}
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  renameSync(tmp, target);
}
