import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { PLUGIN_STATES, type PluginRecord } from './lifecycle';

export interface RegistryFile {
  version: 1;
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
    (v.mcpTools === undefined || isStringArray(v.mcpTools)) &&
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
    pendingOk
  );
}

/** Main 私有文件，不放进 settings.json：远端渲染进程能写设置，不能让它自己给插件授权 */
export function readRegistry(root: string): RegistryFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'));
  } catch {
    return { version: 1, plugins: [] };
  }
  const list = isRecord(parsed) && Array.isArray(parsed.plugins) ? parsed.plugins : [];
  const seen = new Set<string>();
  const plugins: PluginRecord[] = [];
  for (const item of list) {
    if (!isPluginRecord(item) || seen.has(item.id)) continue;
    seen.add(item.id);
    const { lastError, source, ...rest } = item;
    plugins.push({
      ...rest,
      ...(lastError && isLastError(lastError) ? { lastError } : {}),
      ...(isSource(source) ? { source } : {}),
    });
  }
  return { version: 1, plugins };
}

const isLastError = (v: unknown) =>
  v === undefined || (isRecord(v) && typeof v.at === 'number' && typeof v.message === 'string');

/** 只认绝对路径与 http(s) 链接；其它一律当作没有记录来源 */
function isSource(v: unknown): v is NonNullable<PluginRecord['source']> {
  if (!isRecord(v)) return false;
  if (v.kind === 'dir' || v.kind === 'zip') return typeof v.path === 'string' && isAbsolute(v.path);
  return v.kind === 'url' && typeof v.url === 'string' && /^https?:\/\//i.test(v.url);
}

export function writeRegistry(root: string, file: RegistryFile): void {
  mkdirSync(root, { recursive: true });
  const target = join(root, 'registry.json');
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  renameSync(tmp, target);
}
