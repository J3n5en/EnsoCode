import { isReservedAgentTypeName } from '../builtinAgents';
import { type ApprovalMode, THINKING_LEVELS, type ThinkingLevel } from '../types/agent';
import { BUILTIN_AGENT_TYPES } from '../types/assets';
import {
  isInterceptEvent,
  PLUGIN_EVENTS,
  type PluginEventName,
  type PluginEventSubscription,
} from './events';
import { pluginToolName } from './toolName';

export const EXTENSION_PLUGIN_PERMISSIONS = [
  'agent.tool',
  'ui.slot',
  'ui.view',
  'ui.notify',
  'composer.draft',
  'fs.read',
  'fs.write',
  'net.fetch',
  'mcp.server',
  'mcp.call',
  'agent.observe',
  'agent.intercept',
  'agent.inject',
  'process.background',
  'plugin.call',
  'ui.clipboard',
  'ui.openExternal',
  'session.read',
  'session.focus',
  'session.create',
] as const;
export type ExtensionPluginPermission = (typeof EXTENSION_PLUGIN_PERMISSIONS)[number];

/** @ 与 / 归宿主（文件提及、命令），插件补全只占 # */
export const PLUGIN_TRIGGER_SYMBOLS = ['#'] as const;
export type PluginTriggerSymbol = (typeof PLUGIN_TRIGGER_SYMBOLS)[number];

export interface PluginAgentToolContrib {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** 单次调用上限；缺省 60 秒 */
  timeoutMs?: number;
}
export interface PluginCommandContrib {
  id: string;
  title: string;
}
export interface PluginViewContrib {
  id: string;
  title: string;
  entry: string;
}
export interface PluginTriggerContrib {
  symbol: PluginTriggerSymbol;
  name: string;
}
export interface PluginMcpContrib {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}
/** 渲染层可调方法的超时声明；未声明的方法按默认 2 秒 */
export interface PluginMethodContrib {
  name: string;
  timeoutMs: number;
}
export const PLUGIN_CONFIG_TYPES = ['string', 'number', 'boolean', 'enum', 'path'] as const;
export type PluginConfigType = (typeof PLUGIN_CONFIG_TYPES)[number];
export interface PluginConfigContrib {
  key: string;
  title: string;
  description: string;
  secret: boolean;
  type: PluginConfigType;
  default?: string | number | boolean;
  options?: string[];
  min?: number;
  max?: number;
  pathKind?: 'file' | 'directory';
}
export interface PluginScheduleContrib {
  id: string;
  intervalSeconds: number;
  timeoutMs?: number;
}
/** 允许其他插件调用的方法 */
export interface PluginExportContrib {
  name: string;
  timeoutMs?: number;
}
/** 插件自带的会话预设。skill / MCP 只能引用本插件已声明的贡献 */
export interface PluginPresetContrib {
  id: string;
  name: string;
  skills: string[];
  mcpServers: string[];
  instruction?: string;
  systemPrompt?: string;
  systemPromptTail?: string;
  boostPrompt?: string;
  refusalRetry?: boolean;
  refusalRetryPrompt?: string;
  model?: { providerId: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  /** 只能比用户默认更严：supervised / auto-edits */
  approvalMode?: Extract<ApprovalMode, 'supervised' | 'auto-edits'>;
  disabledTools?: string[];
}
/** 插件自带的子代理类型。systemPrompt 是插件内 Markdown；skills 只能引用本插件已声明的 skill 目录 */
export interface PluginAgentTypeContrib {
  name: string;
  description: string;
  systemPrompt: string;
  tools: 'all' | 'readonly';
  skills: string[];
}

export interface ExtensionPluginManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  /** 插件内图片相对路径（svg/png/jpg/webp） */
  icon?: string;
  ensoRange?: string;
  main?: string;
  renderer?: string;
  permissions: ExtensionPluginPermission[];
  fs: { read: string[]; write: string[] };
  net: { domains: string[] };
  /** 允许调用的宿主 MCP 工具名（不限服务） */
  mcp: { tools: string[] };
  /** 常驻：启用即拉起，不因空闲退出 */
  resident: boolean;
  /** 额外透传给插件进程的环境变量名 */
  env: string[];
  /** 允许调用的其他插件 */
  interop: { call: string[] };
  contributes: {
    agentTools: PluginAgentToolContrib[];
    commands: PluginCommandContrib[];
    views: PluginViewContrib[];
    triggers: PluginTriggerContrib[];
    skills: string[];
    mcpServers: PluginMcpContrib[];
    methods: PluginMethodContrib[];
    configuration: PluginConfigContrib[];
    presets: PluginPresetContrib[];
    agentTypes: PluginAgentTypeContrib[];
    events: PluginEventSubscription[];
    schedules: PluginScheduleContrib[];
    exports: PluginExportContrib[];
    /** 运行期可额外注册的工具 / 命令上限 */
    dynamic: { tools: number; commands: number };
  };
}

export type ManifestParseResult =
  | { ok: true; manifest: ExtensionPluginManifest; warnings: string[] }
  | { ok: false; errors: string[] };

const ID = /^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/;
const TOOL = /^[a-z][a-z0-9_]*$/;
const LOCAL_ID = /^[a-z][a-z0-9-]{0,31}$/;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ENGINE = /^>=(\d+)\.(\d+)\.(\d+)$/;
const METHOD = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const MCP_TOOL = /^[A-Za-z0-9_.-]{1,64}$/;
const CONFIG_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const TOOL_NAME_REF = /^[A-Za-z0-9_.-]{1,64}$/;
/** 子代理类型名：小写 slug，可带一个 `前缀:` 命名空间，总长 ≤ 64 */
const AGENT_TYPE_NAME = /^[a-z][a-z0-9_-]*(:[a-z][a-z0-9_-]*)?$/;
const MAX_AGENT_TYPE_NAME = 64;
/** 会改变 Node / Electron 行为或冒充宿主注入值的变量不能声明 */
const RESERVED_ENV = /^(ENSO_|ELECTRON_|NODE_OPTIONS$|NODE_PATH$|NODE_EXTRA_CA_CERTS$|LD_|DYLD_)/;
export const MAX_METHOD_TIMEOUT_MS = 120_000;
export const MAX_TOOL_TIMEOUT_MS = 600_000;
export const MIN_SCHEDULE_SECONDS = 60;
export const MAX_SCHEDULE_SECONDS = 86_400;
export const MAX_DYNAMIC_TOOLS = 50;
export const MAX_DYNAMIC_COMMANDS = 20;
const MAX_CONFIG_ITEMS = 20;
const MAX_PRESETS = 20;
export const MAX_PLUGIN_AGENT_TYPES = 20;
const MAX_SCHEDULES = 10;
const MAX_ENV = 20;
const TOP_LEVEL = new Set([
  'schemaVersion',
  'id',
  'name',
  'version',
  'description',
  'icon',
  'engines',
  'main',
  'renderer',
  'permissions',
  'fs',
  'net',
  'mcp',
  'resident',
  'env',
  'interop',
  'contributes',
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown, max = 200): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const isTimeout = (v: unknown, max: number): v is number =>
  Number.isInteger(v) && (v as number) >= 1000 && (v as number) <= max;

/** 插件目录内的相对路径（`.` 表示根）；只做字符串层判定，符号链接由 Main 安装时校验 */
export function isPluginRelativePath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 256) return false;
  if (path.includes('\\') || path.includes('\0') || path.startsWith('/') || /^[a-zA-Z]:/.test(path))
    return false;
  return path.split('/').every((segment) => segment !== '..');
}

function compareVersion(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/;

function comparePrerelease(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  const x = a.split('.');
  const y = b.split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i];
    const q = y[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** 按 semver 判断 candidate 是否比 current 新；任一方不是 semver 时只看字面是否不同 */
export function isNewerPluginVersion(candidate: string, current: string): boolean {
  const a = SEMVER.exec(candidate.trim());
  const b = SEMVER.exec(current.trim());
  if (!a || !b) return candidate.trim() !== current.trim();
  const core = compareVersion(a.slice(1, 4).map(Number), b.slice(1, 4).map(Number));
  return core !== 0 ? core > 0 : comparePrerelease(a[4], b[4]) > 0;
}

export const isPluginId = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 40 && ID.test(v);

/** `>=x.y.z` 是否被宿主版本满足；格式不对返回 false */
export function enginesAllow(range: unknown, hostVersion: string): boolean {
  const match = typeof range === 'string' ? ENGINE.exec(range) : null;
  if (!match) return false;
  const host = hostVersion.split(/[.-]/).slice(0, 3).map(Number);
  return compareVersion(host, match.slice(1, 4).map(Number)) >= 0;
}

export function parseExtensionPluginManifest(
  raw: unknown,
  hostVersion: string
): ManifestParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ['清单必须是 JSON 对象'] };

  for (const key of Object.keys(raw)) if (!TOP_LEVEL.has(key)) warnings.push(`忽略未知字段 ${key}`);
  if (raw.schemaVersion !== 1) errors.push('schemaVersion 必须为 1');
  const id = raw.id;
  if (typeof id !== 'string' || !ID.test(id) || id.length > 40) errors.push('id 不合法');
  if (!isNonEmptyString(raw.name, 60)) errors.push('name 不合法');
  if (!isNonEmptyString(raw.version, 40)) errors.push('version 不合法');
  if (raw.description !== undefined && typeof raw.description !== 'string')
    errors.push('description 不合法');

  let ensoRange: string | undefined;
  if (raw.engines !== undefined) {
    const range = isRecord(raw.engines) ? raw.engines.enso : undefined;
    const match = typeof range === 'string' ? ENGINE.exec(range) : null;
    if (!match) errors.push('engines.enso 只支持 >=x.y.z');
    else {
      ensoRange = range as string;
      const host = hostVersion.split(/[.-]/).slice(0, 3).map(Number);
      if (compareVersion(host, match.slice(1, 4).map(Number)) < 0)
        errors.push(`需要 Enso ${ensoRange}`);
    }
  }

  const optionalPath = (key: 'main' | 'renderer'): string | undefined => {
    const value = raw[key];
    if (value === undefined) return undefined;
    if (!isPluginRelativePath(value) || value === '.') errors.push(`${key} 路径不合法`);
    return typeof value === 'string' ? value : undefined;
  };
  const main = optionalPath('main');
  const renderer = optionalPath('renderer');
  let icon: string | undefined;
  if (raw.icon !== undefined) {
    if (isPluginRelativePath(raw.icon) && /\.(svg|png|jpe?g|webp)$/i.test(raw.icon))
      icon = raw.icon;
    else errors.push('icon 路径不合法');
  }

  const permissions: ExtensionPluginPermission[] = [];
  if (!Array.isArray(raw.permissions)) errors.push('permissions 必须是数组');
  else
    for (const p of raw.permissions) {
      if ((EXTENSION_PLUGIN_PERMISSIONS as readonly unknown[]).includes(p)) {
        if (!permissions.includes(p as ExtensionPluginPermission))
          permissions.push(p as ExtensionPluginPermission);
      } else errors.push(`未知权限 ${String(p)}`);
    }

  const stringList = (value: unknown, label: string, check: (v: unknown) => boolean): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every(check)) {
      errors.push(`${label} 不合法`);
      return [];
    }
    return [...new Set(value as string[])];
  };
  const fsRaw = raw.fs === undefined ? {} : raw.fs;
  if (!isRecord(fsRaw)) errors.push('fs 不合法');
  const fs = {
    read: stringList(isRecord(fsRaw) ? fsRaw.read : undefined, 'fs.read', isPluginRelativePath),
    write: stringList(isRecord(fsRaw) ? fsRaw.write : undefined, 'fs.write', isPluginRelativePath),
  };
  const netRaw = raw.net === undefined ? {} : raw.net;
  if (!isRecord(netRaw)) errors.push('net 不合法');
  const net = {
    domains: stringList(
      isRecord(netRaw) ? netRaw.domains : undefined,
      'net.domains',
      (d) => typeof d === 'string' && DOMAIN.test(d)
    ),
  };
  const mcpRaw = raw.mcp === undefined ? {} : raw.mcp;
  if (!isRecord(mcpRaw)) errors.push('mcp 不合法');
  const mcp = {
    tools: stringList(
      isRecord(mcpRaw) ? mcpRaw.tools : undefined,
      'mcp.tools',
      (t) => typeof t === 'string' && MCP_TOOL.test(t)
    ),
  };

  if (raw.resident !== undefined && typeof raw.resident !== 'boolean')
    errors.push('resident 不合法');
  const resident = raw.resident === true;
  const env = stringList(
    raw.env,
    'env',
    (name) => typeof name === 'string' && ENV_NAME.test(name) && !RESERVED_ENV.test(name)
  );
  if (env.length > MAX_ENV) errors.push(`env 最多 ${MAX_ENV} 项`);
  const interopRaw = raw.interop === undefined ? {} : raw.interop;
  if (!isRecord(interopRaw)) errors.push('interop 不合法');
  const interop = {
    call: stringList(
      isRecord(interopRaw) ? interopRaw.call : undefined,
      'interop.call',
      (target) => typeof target === 'string' && ID.test(target) && target !== id
    ),
  };

  const c = raw.contributes === undefined ? {} : raw.contributes;
  if (!isRecord(c)) errors.push('contributes 不合法');
  const contrib = isRecord(c) ? c : {};
  const list = (key: string): unknown[] => {
    const value = contrib[key];
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      errors.push(`contributes.${key} 必须是数组`);
      return [];
    }
    return value;
  };
  const uniqueIds = (items: { id?: string; name?: string }[], label: string) => {
    const seen = new Set<string>();
    for (const item of items) {
      const key = item.id ?? item.name ?? '';
      if (seen.has(key)) errors.push(`${label} 重复：${key}`);
      seen.add(key);
    }
  };

  const agentTools: PluginAgentToolContrib[] = [];
  for (const t of list('agentTools')) {
    const name = isRecord(t) ? t.name : undefined;
    const valid =
      typeof name === 'string' &&
      TOOL.test(name) &&
      !name.includes('__') &&
      typeof id === 'string' &&
      pluginToolName(id, name).length <= 64;
    if (!isRecord(t) || !valid) {
      errors.push(`工具名不合法：${String(name)}`);
      continue;
    }
    if (!isNonEmptyString(t.description, 1024)) errors.push(`工具 ${name} 缺少 description`);
    if (t.timeoutMs !== undefined && !isTimeout(t.timeoutMs, MAX_TOOL_TIMEOUT_MS))
      errors.push(`工具 ${name} 的 timeoutMs 不合法（1000–${MAX_TOOL_TIMEOUT_MS} 毫秒的整数）`);
    if (!isRecord(t.parameters) || t.parameters.type !== 'object')
      errors.push(`工具 ${name} 的 parameters 必须是 type=object 的 JSON Schema`);
    else
      agentTools.push({
        name: name as string,
        description: String(t.description ?? ''),
        parameters: t.parameters,
        ...(isTimeout(t.timeoutMs, MAX_TOOL_TIMEOUT_MS) ? { timeoutMs: t.timeoutMs } : {}),
      });
  }
  uniqueIds(agentTools, '工具');

  const commands: PluginCommandContrib[] = [];
  for (const cmd of list('commands')) {
    if (
      !isRecord(cmd) ||
      typeof cmd.id !== 'string' ||
      !LOCAL_ID.test(cmd.id) ||
      !isNonEmptyString(cmd.title, 60)
    )
      errors.push('命令不合法');
    else commands.push({ id: cmd.id, title: cmd.title as string });
  }
  uniqueIds(commands, '命令');

  const views: PluginViewContrib[] = [];
  for (const v of list('views')) {
    if (
      !isRecord(v) ||
      typeof v.id !== 'string' ||
      !LOCAL_ID.test(v.id) ||
      !isNonEmptyString(v.title, 40) ||
      !isPluginRelativePath(v.entry) ||
      !v.entry.endsWith('.html')
    )
      errors.push('侧栏页面不合法');
    else views.push({ id: v.id, title: v.title as string, entry: v.entry });
  }
  uniqueIds(views, '侧栏页面');

  const triggers: PluginTriggerContrib[] = [];
  for (const t of list('triggers')) {
    if (
      !isRecord(t) ||
      !(PLUGIN_TRIGGER_SYMBOLS as readonly unknown[]).includes(t.symbol) ||
      typeof t.name !== 'string' ||
      !LOCAL_ID.test(t.name)
    )
      errors.push('补全来源不合法');
    else triggers.push({ symbol: t.symbol as PluginTriggerSymbol, name: t.name });
  }
  uniqueIds(triggers, '补全来源');

  const skills = stringList(
    contrib.skills,
    'contributes.skills',
    (p) => isPluginRelativePath(p) && p !== '.'
  );

  const mcpServers: PluginMcpContrib[] = [];
  for (const s of list('mcpServers')) {
    const env = isRecord(s) && s.env !== undefined ? s.env : {};
    const args = isRecord(s) && s.args !== undefined ? s.args : [];
    if (
      !isRecord(s) ||
      typeof s.name !== 'string' ||
      !LOCAL_ID.test(s.name) ||
      !isNonEmptyString(s.command, 512) ||
      !Array.isArray(args) ||
      !args.every((a) => typeof a === 'string') ||
      !isRecord(env) ||
      !Object.values(env).every((v) => typeof v === 'string')
    )
      errors.push('MCP 服务不合法');
    else
      mcpServers.push({
        name: s.name,
        command: s.command as string,
        args: args as string[],
        env: env as Record<string, string>,
      });
  }
  uniqueIds(mcpServers, 'MCP 服务');

  const promptPath = (value: unknown, label: string): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !isPluginRelativePath(value) || value === '.') {
      errors.push(`${label} 路径不合法`);
      return undefined;
    }
    return value;
  };
  const presets: PluginPresetContrib[] = [];
  const presetRaw = list('presets');
  if (presetRaw.length > MAX_PRESETS) errors.push(`预设最多 ${MAX_PRESETS} 个`);
  for (const item of presetRaw) {
    if (!isRecord(item) || typeof item.id !== 'string' || !LOCAL_ID.test(item.id)) {
      errors.push('预设不合法');
      continue;
    }
    if (!isNonEmptyString(item.name, 60)) errors.push(`预设 ${item.id} 的名称不合法`);
    const presetSkills = stringList(
      item.skills,
      `预设 ${item.id} 的 skills`,
      (p) => typeof p === 'string' && skills.includes(p)
    );
    if (Array.isArray(item.skills) && item.skills.some((p) => !skills.includes(p)))
      errors.push(`预设 ${item.id} 引用了未声明的 skill`);
    const presetMcp = stringList(
      item.mcpServers,
      `预设 ${item.id} 的 mcpServers`,
      (name) => typeof name === 'string' && mcpServers.some((server) => server.name === name)
    );
    if (
      Array.isArray(item.mcpServers) &&
      item.mcpServers.some(
        (name) => typeof name !== 'string' || !mcpServers.some((server) => server.name === name)
      )
    )
      errors.push(`预设 ${item.id} 引用了未声明的 MCP 服务`);
    const instruction = promptPath(item.instruction, `预设 ${item.id} 的指令`);
    const systemPrompt = promptPath(item.systemPrompt, `预设 ${item.id} 的角色描述`);
    const systemPromptTail = promptPath(item.systemPromptTail, `预设 ${item.id} 的真尾`);
    const boostPrompt = promptPath(item.boostPrompt, `预设 ${item.id} 的 boost`);
    const refusalRetryPrompt = promptPath(item.refusalRetryPrompt, `预设 ${item.id} 的推脱补发`);
    if (item.refusalRetry !== undefined && typeof item.refusalRetry !== 'boolean')
      errors.push(`预设 ${item.id} 的 refusalRetry 不合法`);
    if (item.refusalRetry === true && !refusalRetryPrompt)
      errors.push(`预设 ${item.id} 开启了推脱补发但没有正文`);
    const model = item.model;
    const modelOk =
      model === undefined ||
      (isRecord(model) &&
        isNonEmptyString(model.providerId, 120) &&
        isNonEmptyString(model.modelId, 200));
    if (!modelOk) errors.push(`预设 ${item.id} 的 model 不合法`);
    if (
      item.thinkingLevel !== undefined &&
      !(THINKING_LEVELS as readonly unknown[]).includes(item.thinkingLevel)
    )
      errors.push(`预设 ${item.id} 的 thinkingLevel 不合法`);
    if (
      item.approvalMode !== undefined &&
      item.approvalMode !== 'supervised' &&
      item.approvalMode !== 'auto-edits'
    )
      errors.push(`预设 ${item.id} 的 approvalMode 只能是 supervised 或 auto-edits`);
    const disabledTools = stringList(
      item.disabledTools,
      `预设 ${item.id} 的 disabledTools`,
      (t) => typeof t === 'string' && TOOL_NAME_REF.test(t)
    );
    presets.push({
      id: item.id,
      name: typeof item.name === 'string' ? item.name.trim() : '',
      skills: presetSkills,
      mcpServers: presetMcp,
      ...(instruction ? { instruction } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(systemPromptTail ? { systemPromptTail } : {}),
      ...(boostPrompt ? { boostPrompt } : {}),
      ...(item.refusalRetry === true ? { refusalRetry: true } : {}),
      ...(refusalRetryPrompt ? { refusalRetryPrompt } : {}),
      ...(modelOk && isRecord(model)
        ? { model: { providerId: model.providerId as string, modelId: model.modelId as string } }
        : {}),
      ...((THINKING_LEVELS as readonly unknown[]).includes(item.thinkingLevel)
        ? { thinkingLevel: item.thinkingLevel as ThinkingLevel }
        : {}),
      ...(item.approvalMode === 'supervised' || item.approvalMode === 'auto-edits'
        ? { approvalMode: item.approvalMode }
        : {}),
      ...(disabledTools.length > 0 ? { disabledTools } : {}),
    });
  }
  uniqueIds(presets, '预设');

  const agentTypes: PluginAgentTypeContrib[] = [];
  const agentTypeRaw = list('agentTypes');
  if (agentTypeRaw.length > MAX_PLUGIN_AGENT_TYPES)
    errors.push(`子代理类型最多 ${MAX_PLUGIN_AGENT_TYPES} 个`);
  for (const item of agentTypeRaw) {
    const name = isRecord(item) ? item.name : undefined;
    if (
      !isRecord(item) ||
      typeof name !== 'string' ||
      name.length > MAX_AGENT_TYPE_NAME ||
      !AGENT_TYPE_NAME.test(name) ||
      isReservedAgentTypeName(name) ||
      BUILTIN_AGENT_TYPES.some((builtin) => builtin.name === name)
    ) {
      errors.push(`子代理类型名不合法：${String(name)}`);
      continue;
    }
    if (!isNonEmptyString(item.description, 1024))
      errors.push(`子代理类型 ${name} 缺少 description`);
    const systemPrompt = promptPath(item.systemPrompt, `子代理类型 ${name} 的 systemPrompt`);
    if (item.systemPrompt === undefined) errors.push(`子代理类型 ${name} 缺少 systemPrompt`);
    const tools = item.tools ?? 'all';
    if (tools !== 'all' && tools !== 'readonly')
      errors.push(`子代理类型 ${name} 的 tools 只能是 all 或 readonly`);
    const typeSkills = stringList(
      item.skills,
      `子代理类型 ${name} 的 skills`,
      (p) => typeof p === 'string' && skills.includes(p)
    );
    if (Array.isArray(item.skills) && item.skills.some((p) => !skills.includes(p)))
      errors.push(`子代理类型 ${name} 引用了未声明的 skill`);
    agentTypes.push({
      name,
      description: typeof item.description === 'string' ? item.description.trim() : '',
      systemPrompt: systemPrompt ?? '',
      tools: tools === 'readonly' ? 'readonly' : 'all',
      skills: typeSkills,
    });
  }
  uniqueIds(agentTypes, '子代理类型');

  const methods: PluginMethodContrib[] = [];
  for (const m of list('methods')) {
    if (
      !isRecord(m) ||
      typeof m.name !== 'string' ||
      !METHOD.test(m.name) ||
      !Number.isInteger(m.timeoutMs) ||
      (m.timeoutMs as number) < 1000 ||
      (m.timeoutMs as number) > MAX_METHOD_TIMEOUT_MS
    )
      errors.push('方法超时声明不合法（1000–120000 毫秒的整数）');
    else methods.push({ name: m.name, timeoutMs: m.timeoutMs as number });
  }
  uniqueIds(methods, '方法');

  const configuration: PluginConfigContrib[] = [];
  const configRaw = list('configuration');
  if (configRaw.length > MAX_CONFIG_ITEMS) errors.push(`配置项最多 ${MAX_CONFIG_ITEMS} 个`);
  for (const c of configRaw) {
    const field = parseConfigField(c);
    if (!field) errors.push(`配置项不合法：${isRecord(c) ? String(c.key) : ''}`);
    else configuration.push(field);
  }
  uniqueIds(
    configuration.map((c) => ({ id: c.key })),
    '配置项'
  );

  const events: PluginEventSubscription[] = [];
  for (const e of list('events')) {
    const sub = parseEventSubscription(e);
    if (!sub) {
      errors.push(`事件订阅不合法：${isRecord(e) ? String(e.event) : ''}`);
      continue;
    }
    if (events.some((x) => x.event === sub.event)) errors.push(`事件重复：${sub.event}`);
    events.push(sub);
  }

  const schedules: PluginScheduleContrib[] = [];
  const scheduleRaw = list('schedules');
  if (scheduleRaw.length > MAX_SCHEDULES) errors.push(`定时任务最多 ${MAX_SCHEDULES} 个`);
  for (const s of scheduleRaw) {
    if (
      !isRecord(s) ||
      typeof s.id !== 'string' ||
      !LOCAL_ID.test(s.id) ||
      !Number.isInteger(s.intervalSeconds) ||
      (s.intervalSeconds as number) < MIN_SCHEDULE_SECONDS ||
      (s.intervalSeconds as number) > MAX_SCHEDULE_SECONDS ||
      (s.timeoutMs !== undefined && !isTimeout(s.timeoutMs, MAX_TOOL_TIMEOUT_MS))
    )
      errors.push(
        `定时任务不合法（间隔 ${MIN_SCHEDULE_SECONDS}–${MAX_SCHEDULE_SECONDS} 秒的整数）`
      );
    else
      schedules.push({
        id: s.id,
        intervalSeconds: s.intervalSeconds as number,
        ...(s.timeoutMs !== undefined ? { timeoutMs: s.timeoutMs as number } : {}),
      });
  }
  uniqueIds(schedules, '定时任务');

  const exportsList: PluginExportContrib[] = [];
  for (const x of list('exports')) {
    if (
      !isRecord(x) ||
      typeof x.name !== 'string' ||
      !METHOD.test(x.name) ||
      (x.timeoutMs !== undefined && !isTimeout(x.timeoutMs, MAX_METHOD_TIMEOUT_MS))
    )
      errors.push('导出方法不合法');
    else
      exportsList.push({
        name: x.name,
        ...(x.timeoutMs !== undefined ? { timeoutMs: x.timeoutMs as number } : {}),
      });
  }
  uniqueIds(exportsList, '导出方法');

  const dynamicRaw = contrib.dynamic === undefined ? {} : contrib.dynamic;
  const count = (value: unknown, max: number, label: string): number => {
    if (value === undefined) return 0;
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > max) {
      errors.push(`contributes.dynamic.${label} 必须是 0–${max} 的整数`);
      return 0;
    }
    return value as number;
  };
  if (!isRecord(dynamicRaw)) errors.push('contributes.dynamic 不合法');
  const dynamic = {
    tools: count(isRecord(dynamicRaw) ? dynamicRaw.tools : undefined, MAX_DYNAMIC_TOOLS, 'tools'),
    commands: count(
      isRecord(dynamicRaw) ? dynamicRaw.commands : undefined,
      MAX_DYNAMIC_COMMANDS,
      'commands'
    ),
  };

  const need = (present: boolean, permission: ExtensionPluginPermission, label: string) => {
    if (present && !permissions.includes(permission))
      errors.push(`${label} 需要权限 ${permission}`);
  };
  need(agentTools.length > 0, 'agent.tool', 'agentTools');
  need(dynamic.tools > 0, 'agent.tool', 'contributes.dynamic.tools');
  need(
    events.some((e) => e.mode === 'observe'),
    'agent.observe',
    'events'
  );
  need(
    events.some((e) => e.mode === 'intercept'),
    'agent.intercept',
    '拦截型 events'
  );
  need(resident, 'process.background', 'resident');
  need(schedules.length > 0, 'process.background', 'schedules');
  need(interop.call.length > 0, 'plugin.call', 'interop.call');
  if (permissions.includes('plugin.call') && interop.call.length === 0)
    errors.push('plugin.call 需要在 interop.call 里列出要调用的插件');
  need(renderer !== undefined, 'ui.slot', 'renderer');
  need(triggers.length > 0, 'ui.slot', 'triggers');
  need(views.length > 0, 'ui.view', 'views');
  need(mcpServers.length > 0, 'mcp.server', 'mcpServers');
  need(fs.read.length > 0, 'fs.read', 'fs.read');
  need(fs.write.length > 0, 'fs.write', 'fs.write');
  need(net.domains.length > 0, 'net.fetch', 'net.domains');
  need(mcp.tools.length > 0, 'mcp.call', 'mcp.tools');
  if (permissions.includes('mcp.call') && mcp.tools.length === 0)
    errors.push('mcp.call 需要在 mcp.tools 里列出要调用的工具');
  if (
    !main &&
    (agentTools.length > 0 ||
      commands.length > 0 ||
      triggers.length > 0 ||
      methods.length > 0 ||
      configuration.length > 0 ||
      events.length > 0 ||
      schedules.length > 0 ||
      exportsList.length > 0 ||
      resident ||
      dynamic.tools > 0 ||
      dynamic.commands > 0)
  )
    errors.push('声明了工具、命令、补全来源、方法、配置项、事件、定时或常驻时必须提供 main');

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    warnings,
    manifest: {
      schemaVersion: 1,
      id: id as string,
      name: (raw.name as string).trim(),
      version: raw.version as string,
      description: typeof raw.description === 'string' ? raw.description : '',
      ...(icon ? { icon } : {}),
      ...(ensoRange ? { ensoRange } : {}),
      ...(main ? { main } : {}),
      ...(renderer ? { renderer } : {}),
      permissions,
      fs,
      net,
      mcp,
      resident,
      env,
      interop,
      contributes: {
        agentTools,
        commands,
        views,
        triggers,
        skills,
        mcpServers,
        methods,
        configuration,
        presets,
        agentTypes,
        events,
        schedules,
        exports: exportsList,
        dynamic,
      },
    },
  };
}

function parseEventSubscription(raw: unknown): PluginEventSubscription | null {
  if (!isRecord(raw) || !(PLUGIN_EVENTS as readonly unknown[]).includes(raw.event)) return null;
  const event = raw.event as PluginEventName;
  const mode = raw.mode ?? 'observe';
  if (mode !== 'observe' && mode !== 'intercept') return null;
  if (mode === 'intercept' && !isInterceptEvent(event)) return null;
  if (raw.failClosed !== undefined && (typeof raw.failClosed !== 'boolean' || mode !== 'intercept'))
    return null;
  let tools: string[] | undefined;
  if (raw.tools !== undefined) {
    if (event !== 'tool_call' && event !== 'tool_result') return null;
    if (
      !Array.isArray(raw.tools) ||
      raw.tools.length === 0 ||
      raw.tools.length > 50 ||
      !raw.tools.every((t) => typeof t === 'string' && TOOL_NAME_REF.test(t))
    )
      return null;
    tools = [...new Set(raw.tools as string[])];
  }
  return { event, mode, failClosed: raw.failClosed === true, ...(tools ? { tools } : {}) };
}

function parseConfigField(c: unknown): PluginConfigContrib | null {
  if (
    !isRecord(c) ||
    typeof c.key !== 'string' ||
    !CONFIG_KEY.test(c.key) ||
    !isNonEmptyString(c.title, 60) ||
    (c.description !== undefined && !isNonEmptyString(c.description, 500)) ||
    (c.secret !== undefined && typeof c.secret !== 'boolean')
  )
    return null;
  const type = c.type ?? 'string';
  if (!(PLUGIN_CONFIG_TYPES as readonly unknown[]).includes(type)) return null;
  const secret = c.secret === true;
  if (secret && type !== 'string') return null;
  const field: PluginConfigContrib = {
    key: c.key,
    title: c.title as string,
    description: typeof c.description === 'string' ? c.description : '',
    secret,
    type: type as PluginConfigType,
  };
  const has = (k: string) => c[k] !== undefined;
  const only = (...allowed: string[]) =>
    ['default', 'options', 'min', 'max', 'pathKind'].every((k) => allowed.includes(k) || !has(k));
  switch (type) {
    case 'string':
      if (!only('default') || (has('default') && !isNonEmptyString(c.default, 4096))) return null;
      if (has('default')) field.default = c.default as string;
      return field;
    case 'number': {
      if (!only('default', 'min', 'max')) return null;
      const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
      if ((has('min') && !finite(c.min)) || (has('max') && !finite(c.max))) return null;
      if (has('min') && has('max') && (c.min as number) > (c.max as number)) return null;
      if (has('default')) {
        if (!finite(c.default)) return null;
        const d = c.default as number;
        if ((has('min') && d < (c.min as number)) || (has('max') && d > (c.max as number)))
          return null;
        field.default = d;
      }
      if (has('min')) field.min = c.min as number;
      if (has('max')) field.max = c.max as number;
      return field;
    }
    case 'boolean':
      if (!only('default') || (has('default') && typeof c.default !== 'boolean')) return null;
      if (has('default')) field.default = c.default as boolean;
      return field;
    case 'enum': {
      if (!only('default', 'options')) return null;
      const options = c.options;
      if (
        !Array.isArray(options) ||
        options.length === 0 ||
        options.length > 50 ||
        !options.every((o) => isNonEmptyString(o, 200)) ||
        new Set(options).size !== options.length
      )
        return null;
      if (has('default') && !(options as unknown[]).includes(c.default)) return null;
      field.options = options as string[];
      if (has('default')) field.default = c.default as string;
      return field;
    }
    default:
      if (!only('pathKind')) return null;
      if (has('pathKind') && c.pathKind !== 'file' && c.pathKind !== 'directory') return null;
      field.pathKind = c.pathKind === 'directory' ? 'directory' : 'file';
      return field;
  }
}
