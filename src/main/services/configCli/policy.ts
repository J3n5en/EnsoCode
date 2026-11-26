import { isStoredComposerToolbar } from '@shared/composerToolbar';
import { MEMORY_DISTILL_WINDOW_MINUTES } from '@shared/memory/distillWindow';
import {
  hasApiKeyProviderCredentials,
  isProviderModelRefreshIntervalHours,
  MAX_PROVIDER_MODEL_REFRESH_INTERVAL_HOURS,
  MIN_PROVIDER_MODEL_REFRESH_INTERVAL_HOURS,
  normalizeProviderModelRefreshIntervalHours,
} from '@shared/providers/modelRefreshInterval';
import { redactProxyUrlCredentials } from '@shared/providers/providerProxy';
import { isValidProxyUrl, PROXY_MODES } from '@shared/proxy';
import { isRecentModelList, MAX_RECENT_MODELS } from '@shared/recentModels';

/**
 * 本机配置 CLI 的键策略：键 = `<state 字段>[.<子键>…]`，数组段按元素 id（或下标）定位。
 * 默认允许，黑名单拒绝：密钥/凭据、文件路径、命令执行、插件/技能装卸、项目数据。
 */

export const HIDDEN = '***';

const SECRET_NAME =
  /api[-_]?key|secret|passw(?:or)?d|credential|authorization|cookie|token$|(?:^|[-_])token(?:[-_]|$)|^env$/i;
/** 名字里含 secret 字样但不是密钥的字段（`secret` 子串匹配会误伤） */
const NOT_SECRET_FIELDS = new Set(['secretaryEnabled']);
const PATH_OR_EXEC_NAME = /^(?:path|dir|root|cwd|command|args)$|(?:Path|Dir|Root)$/;
const UNSAFE_SEGMENT = new Set(['__proto__', 'prototype', 'constructor']);

/** 项目/会话数据由 Main 权威投影维护，CLI 不读不写 */
const READ_DENIED = new Set(['projects', 'projectGroups']);
/** 写入即改文件路径或可执行入口；或与 Main 管理的本机文件配对、只能经设置页专用 IPC 改的标记 */
const WRITE_DENIED = new Set([
  'worktreeRoot',
  'backgroundImagePath',
  'backgroundFolderPath',
  'terminalShell',
  'windowsLocalShell',
  'fileOpenRules',
  'contextMenuOpen',
  'gitCommitPromptCustomized',
]);
/** 整体替换或增删条目等同安装/卸载；条目内字段（如 enabled）仍可写 */
const ENTRY_LEVEL_DENIED = new Set(['skills', 'instructions']);
/**
 * 决定 API Key 发往哪里的 provider 字段只能在设置页改：CLI 可被任意本机进程或代理调用，
 * 改了端点或代理会让自动拉取立刻带着 key 请求新地址 / 经新出口。
 */
const PROVIDER_ENDPOINT_FIELDS = new Set(['api', 'baseUrl', 'headers', 'proxy']);
const isProviderEndpointPath = (segs: readonly string[]): boolean =>
  segs[0] === 'providers' && segs.length >= 3 && PROVIDER_ENDPOINT_FIELDS.has(segs[2]);
/** 启动时读入、UI 另走专用 IPC 的项：只改设置不会生效 */
const RESTART_REQUIRED: Record<string, string> = {
  autoUpdate: 'The updater reads this at startup; toggle it in Settings or restart the app.',
  autoRestartForUpdate:
    'The updater reads this at startup; change it in Settings or restart the app.',
  updateChannel: 'The updater reads this at startup; switch it in Settings or restart the app.',
};

export type GetResult =
  | { ok: true; key: string; value: unknown }
  | { ok: false; error: string; hidden?: true };

export type SetPlan =
  | { ok: true; field: string; value: unknown }
  | { ok: false; error: string }
  | { ok: false; requiresRestart: true; reason: string };

export const isSecretName = (name: string): boolean =>
  !NOT_SECRET_FIELDS.has(name) && SECRET_NAME.test(name);
const isPathOrExecName = (name: string): boolean => PATH_OR_EXEC_NAME.test(name);

export interface KeySchema {
  path: string;
  type: string;
  writable: boolean;
  requiresRestart: boolean;
  secret: boolean;
}

const SCHEMA_MAX_DEPTH = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function splitKey(key: unknown): string[] | null {
  if (typeof key !== 'string' || !key.trim()) return null;
  const segs = key.trim().split('.');
  return segs.every((s) => s !== '' && !UNSAFE_SEGMENT.has(s)) ? segs : null;
}

function childIndex(container: unknown[], seg: string): number {
  const byId = container.findIndex((item) => isRecord(item) && item.id === seg);
  if (byId >= 0) return byId;
  return /^\d+$/.test(seg) && Number(seg) < container.length ? Number(seg) : -1;
}

function providerRefreshField(segs: readonly string[]) {
  if (segs.length !== 3 || segs[0] !== 'providers') return;
  const field = segs[2];
  if (field === 'autoFetchModels' || field === 'modelRefreshIntervalHours') return field;
}

function apiKeyProviderAt(state: Record<string, unknown>, segs: string[]) {
  const { value } = lookup(state, segs.slice(0, 2));
  return isRecord(value) && hasApiKeyProviderCredentials(value) ? value : undefined;
}

function lookup(root: unknown, segs: string[]): { found: boolean; value: unknown } {
  let current = root;
  for (const seg of segs) {
    if (Array.isArray(current)) {
      const index = childIndex(current, seg);
      if (index < 0) return { found: false, value: undefined };
      current = current[index];
    } else if (isRecord(current) && Object.hasOwn(current, seg)) {
      current = current[seg];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: current };
}

/** 不可变地写入嵌套路径；数组只能改已有元素，对象可新增叶子 */
function assignIn(container: unknown, segs: string[], value: unknown): unknown {
  const [seg, ...rest] = segs;
  if (Array.isArray(container)) {
    const index = childIndex(container, seg);
    if (index < 0) throw new Error(`No entry "${seg}"`);
    const next = [...container];
    next[index] = rest.length ? assignIn(container[index], rest, value) : value;
    return next;
  }
  if (isRecord(container)) {
    if (rest.length && !Object.hasOwn(container, seg)) throw new Error(`No key "${seg}"`);
    return { ...container, [seg]: rest.length ? assignIn(container[seg], rest, value) : value };
  }
  throw new Error(`Cannot descend into "${seg}"`);
}

/** 深拷贝并把密钥类键的值换成 HIDDEN（空值保留，表示未设置）；provider 代理地址去掉账密 */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [
      name,
      isSecretName(name)
        ? item === '' || item == null
          ? item
          : HIDDEN
        : name === 'proxy' && isRecord(item) && typeof item.url === 'string'
          ? { ...item, url: redactProxyUrlCredentials(item.url) }
          : redact(item),
    ])
  );
}

/** 直接读 `providers.<id>.proxy` / `.proxy.url` 时同样隐去账密 */
function redactAt(segs: readonly string[], value: unknown): unknown {
  if (segs[0] === 'providers' && segs[2] === 'proxy') {
    if (segs.length === 3) return (redact({ proxy: value }) as { proxy: unknown }).proxy;
    if (segs[3] === 'url' && typeof value === 'string') return redactProxyUrlCredentials(value);
  }
  return redact(value);
}

function deniedKeyIn(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = deniedKeyIn(item);
      if (hit) return hit;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [name, item] of Object.entries(value)) {
    if (isSecretName(name) || isPathOrExecName(name)) return name;
    const hit = deniedKeyIn(item);
    if (hit) return hit;
  }
  return null;
}

function jsonType(value: unknown): string {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}

/** 数组元素合并成一个样本对象，路径段用 <id>（元素都有 id）或 <index> 占位 */
function arraySample(items: unknown[]): { seg: string; sample: Record<string, unknown> } | null {
  const records = items.filter(isRecord);
  if (!records.length) return null;
  const seg = records.every((item) => typeof item.id === 'string') ? '<id>' : '<index>';
  return { seg, sample: Object.assign({}, ...records) };
}

function keySchema(segs: string[], value: unknown, present: boolean): KeySchema {
  const [field] = segs;
  const secret = segs.some(isSecretName);
  const requiresRestart = !!RESTART_REQUIRED[field];
  const writable =
    !secret &&
    !requiresRestart &&
    !segs.some(isPathOrExecName) &&
    !WRITE_DENIED.has(field) &&
    !(ENTRY_LEVEL_DENIED.has(field) && segs.length <= 2) &&
    !isProviderEndpointPath(segs) &&
    !deniedKeyIn(value);
  const type = !present || value === null ? 'unknown' : jsonType(value);
  return { path: segs.join('.'), type, writable, requiresRestart, secret };
}

function walkSchema(segs: string[], value: unknown, out: KeySchema[]): void {
  out.push(keySchema(segs, value, true));
  if (segs.some(isSecretName) || segs.length >= SCHEMA_MAX_DEPTH) return;
  if (Array.isArray(value)) {
    const items = arraySample(value);
    if (items) walkSchema([...segs, items.seg], items.sample, out);
  } else if (isRecord(value)) {
    for (const [name, item] of Object.entries(value)) walkSchema([...segs, name], item, out);
  }
}

/** 从当前 state 生成键清单（不含任何值）：新增设置字段自动出现，规则与 planSet 一致 */
export function describeConfig(state: Record<string, unknown>, fields: readonly string[]) {
  const keys: KeySchema[] = [];
  for (const field of fields) {
    if (READ_DENIED.has(field)) continue;
    const value = state[field];
    if (field === 'providers' && Array.isArray(value)) {
      const providers = value.map((entry: unknown) =>
        isRecord(entry) && hasApiKeyProviderCredentials(entry)
          ? {
              ...entry,
              autoFetchModels: entry.autoFetchModels === true,
              modelRefreshIntervalHours: normalizeProviderModelRefreshIntervalHours(
                entry.modelRefreshIntervalHours
              ),
            }
          : entry
      );
      walkSchema([field], providers, keys);
    } else if (Object.hasOwn(state, field)) walkSchema([field], value, keys);
    else keys.push(keySchema([field], undefined, false));
  }
  return {
    keys,
    blacklist: {
      secretKeyPattern: SECRET_NAME.source,
      secret:
        'Any segment matching apiKey/api_key/secret/password/credential/authorization/cookie/*token, or named env: get returns hidden, list shows ***, set is refused.',
      pathOrExecPattern: PATH_OR_EXEC_NAME.source,
      pathOrExec:
        'Any segment named path/dir/root/cwd/command/args or ending in Path/Dir/Root, plus writeDeniedFields: readable, set refused.',
      writeDeniedFields: [...WRITE_DENIED],
      entryLevelDeniedFields: [...ENTRY_LEVEL_DENIED],
      readDeniedFields: [...READ_DENIED],
      deniedOperations: [
        'install/uninstall skills or instructions (replace or add/remove entries)',
        'read or write project/session data (projects, projectGroups)',
        'change file paths, shells or executable commands',
        'change a provider endpoint (providers.<id>.api, baseUrl, headers, proxy; use the Settings page)',
        'read or write secrets (use the Settings page)',
        'overwrite a parent object whose old or new value contains secret/path/command keys',
      ],
    },
    notes: {
      hotReload:
        'set goes through the same Main write path as the Settings page: updates memory, broadcasts to renderers, pushes to agent workers, debounced save; proxy keys re-apply the proxy. Some keys only affect new sessions.',
      requiresRestart: { ...RESTART_REQUIRED },
      transport:
        'Local-only Unix socket <userData>/cli/cli.sock (Windows named pipe) authenticated by the per-launch token in <userData>/cli-token.',
      keyFormat:
        '<field>[.<sub>...]; array segments select an element by id, else by index. <id>/<index> in paths are placeholders. type "unknown" means unset (any JSON accepted).',
    },
  };
}

function validateField(field: string, value: unknown): string | null {
  if (field === 'proxyMode' && !(PROXY_MODES as readonly unknown[]).includes(value))
    return `proxyMode must be one of ${PROXY_MODES.join(', ')}`;
  if (
    field === 'customProxyUrl' &&
    (typeof value !== 'string' || (value.trim() !== '' && !isValidProxyUrl(value)))
  )
    return 'customProxyUrl must be an http(s)/socks proxy URL or empty';
  if (field === 'language' && value !== 'en' && value !== 'zh') return 'language must be en or zh';
  if (field === 'longCacheRetention' && typeof value !== 'boolean')
    return 'longCacheRetention must be a boolean';
  if (field === 'quoteSelectionButton' && typeof value !== 'boolean')
    return 'quoteSelectionButton must be a boolean';
  if (field === 'learnButtonEnabled' && typeof value !== 'boolean')
    return 'learnButtonEnabled must be a boolean';
  if (field === 'composerToolbar' && !isStoredComposerToolbar(value))
    return 'composerToolbar must be { order, pinned } arrays of known toolbar item ids';
  if (field === 'pluginLoggingEnabled' && typeof value !== 'boolean')
    return 'pluginLoggingEnabled must be a boolean';
  if (field === 'appLoggingEnabled' && typeof value !== 'boolean')
    return 'appLoggingEnabled must be a boolean';
  if (field === 'recentModels' && !isRecentModelList(value))
    return `recentModels must be at most ${MAX_RECENT_MODELS} unique { providerId, modelId } entries`;
  if (
    field === 'memoryDistillWindowMinutes' &&
    !(MEMORY_DISTILL_WINDOW_MINUTES as readonly unknown[]).includes(value)
  )
    return `memoryDistillWindowMinutes must be one of ${MEMORY_DISTILL_WINDOW_MINUTES.join(', ')}`;
  return null;
}

function resolveField(key: unknown, fields: readonly string[]): string[] | { error: string } {
  const segs = splitKey(key);
  if (!segs) return { error: 'Invalid key' };
  if (!fields.includes(segs[0])) return { error: `Unknown settings field: ${segs[0]}` };
  if (READ_DENIED.has(segs[0]))
    return { error: `${segs[0]} is project data maintained by the app; not available via CLI` };
  return segs;
}

export function getConfig(
  state: Record<string, unknown>,
  key: unknown,
  fields: readonly string[]
): GetResult {
  const segs = resolveField(key, fields);
  if (!Array.isArray(segs)) return { ok: false, error: segs.error };
  const secret = segs.find(isSecretName);
  if (secret) return { ok: false, hidden: true, error: `Secret field "${secret}" is not readable` };
  const refreshField = providerRefreshField(segs);
  if (refreshField) {
    const provider = apiKeyProviderAt(state, segs);
    if (!provider) return { ok: false, error: `API key provider not found: ${segs[1]}` };
    return {
      ok: true,
      key: segs.join('.'),
      value:
        refreshField === 'autoFetchModels'
          ? provider.autoFetchModels === true
          : normalizeProviderModelRefreshIntervalHours(provider.modelRefreshIntervalHours),
    };
  }
  const { found, value } = lookup(state, segs);
  if (!found) return { ok: false, error: `Key not found: ${segs.join('.')}` };
  return { ok: true, key: segs.join('.'), value: redactAt(segs, value) };
}

export function listConfig(
  state: Record<string, unknown>,
  fields: readonly string[],
  prefix?: unknown
): { key: string; value: unknown }[] {
  const filter = typeof prefix === 'string' ? prefix.trim() : '';
  if (filter.includes('.')) {
    const single = getConfig(state, filter, fields);
    if (single.ok) return [{ key: single.key, value: single.value }];
    return 'hidden' in single ? [{ key: filter, value: HIDDEN }] : [];
  }
  return fields
    .filter((field) => field.startsWith(filter) && !READ_DENIED.has(field))
    .filter((field) => Object.hasOwn(state, field))
    .map((field) => ({ key: field, value: isSecretName(field) ? HIDDEN : redact(state[field]) }));
}

export function planSet(
  state: Record<string, unknown>,
  key: unknown,
  value: unknown,
  fields: readonly string[]
): SetPlan {
  const segs = resolveField(key, fields);
  if (!Array.isArray(segs)) return { ok: false, error: segs.error };
  const [field] = segs;
  const blocked = segs.find((seg) => isSecretName(seg) || isPathOrExecName(seg));
  if (blocked && isSecretName(blocked))
    return { ok: false, error: `Secret field "${blocked}" cannot be set via CLI; use Settings` };
  if (blocked || WRITE_DENIED.has(field))
    return { ok: false, error: `"${segs.join('.')}" sets a file path or command; not allowed` };
  if (ENTRY_LEVEL_DENIED.has(field) && segs.length <= 2)
    return {
      ok: false,
      error: `Adding/removing ${field} entries is an install/uninstall; edit entry fields instead`,
    };
  if (RESTART_REQUIRED[field])
    return { ok: false, requiresRestart: true, reason: RESTART_REQUIRED[field] };
  if (isProviderEndpointPath(segs))
    return {
      ok: false,
      error: `"${segs.join('.')}" decides where the API key is sent; change it in Settings`,
    };

  const refreshField = providerRefreshField(segs);
  if (refreshField) {
    if (!apiKeyProviderAt(state, segs))
      return { ok: false, error: `API key provider not found: ${segs[1]}` };
    if (refreshField === 'autoFetchModels' && typeof value !== 'boolean') {
      return { ok: false, error: 'autoFetchModels must be a boolean' };
    }
    if (
      refreshField === 'modelRefreshIntervalHours' &&
      !isProviderModelRefreshIntervalHours(value)
    ) {
      return {
        ok: false,
        error: `modelRefreshIntervalHours must be a whole number from ${MIN_PROVIDER_MODEL_REFRESH_INTERVAL_HOURS} to ${MAX_PROVIDER_MODEL_REFRESH_INTERVAL_HOURS}`,
      };
    }
    return { ok: true, field, value: assignIn(state[field], segs.slice(1), value) };
  }

  const current = lookup(state, segs);
  const touched = deniedKeyIn(value) ?? deniedKeyIn(current.value);
  if (touched)
    return {
      ok: false,
      error: `Value would touch secret/path/command key "${touched}"; set leaf keys instead`,
    };
  if (current.found && current.value != null) {
    const expected = jsonType(current.value);
    const nullable = expected === 'object' && value === null;
    if (!nullable && jsonType(value) !== expected)
      return {
        ok: false,
        error: `Expected ${expected} for ${segs.join('.')}, got ${jsonType(value)}`,
      };
  }
  if (segs.length === 1) {
    const invalid = validateField(field, value);
    if (invalid) return { ok: false, error: invalid };
    return { ok: true, field, value };
  }
  if (!Object.hasOwn(state, field)) return { ok: false, error: `Key not found: ${segs.join('.')}` };
  try {
    return { ok: true, field, value: assignIn(state[field], segs.slice(1), value) };
  } catch (error) {
    return { ok: false, error: `Key not found: ${segs.join('.')} (${(error as Error).message})` };
  }
}
