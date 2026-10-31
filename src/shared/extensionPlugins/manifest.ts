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
  'session.read',
  'mcp.server',
  'mcp.call',
] as const;
export type ExtensionPluginPermission = (typeof EXTENSION_PLUGIN_PERMISSIONS)[number];

/** @ 与 / 归宿主（文件提及、命令），插件补全只占 # */
export const PLUGIN_TRIGGER_SYMBOLS = ['#'] as const;
export type PluginTriggerSymbol = (typeof PLUGIN_TRIGGER_SYMBOLS)[number];

export interface PluginAgentToolContrib {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
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
export interface PluginConfigContrib {
  key: string;
  title: string;
  description: string;
  secret: boolean;
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
}

export interface ExtensionPluginManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  ensoRange?: string;
  main?: string;
  renderer?: string;
  permissions: ExtensionPluginPermission[];
  fs: { read: string[]; write: string[] };
  net: { domains: string[] };
  /** 允许调用的宿主 MCP 工具名（不限服务） */
  mcp: { tools: string[] };
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
export const MAX_METHOD_TIMEOUT_MS = 120_000;
const MAX_CONFIG_ITEMS = 20;
const MAX_PRESETS = 20;
const TOP_LEVEL = new Set([
  'schemaVersion',
  'id',
  'name',
  'version',
  'description',
  'engines',
  'main',
  'renderer',
  'permissions',
  'fs',
  'net',
  'mcp',
  'contributes',
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown, max = 200): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max;

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
    if (!isRecord(t.parameters) || t.parameters.type !== 'object')
      errors.push(`工具 ${name} 的 parameters 必须是 type=object 的 JSON Schema`);
    else
      agentTools.push({
        name: name as string,
        description: String(t.description ?? ''),
        parameters: t.parameters,
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
    });
  }
  uniqueIds(presets, '预设');

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
    if (
      !isRecord(c) ||
      typeof c.key !== 'string' ||
      !CONFIG_KEY.test(c.key) ||
      !isNonEmptyString(c.title, 60) ||
      (c.description !== undefined && !isNonEmptyString(c.description, 500)) ||
      (c.secret !== undefined && typeof c.secret !== 'boolean')
    )
      errors.push('配置项不合法');
    else
      configuration.push({
        key: c.key,
        title: c.title as string,
        description: typeof c.description === 'string' ? c.description : '',
        secret: c.secret === true,
      });
  }
  uniqueIds(
    configuration.map((c) => ({ id: c.key })),
    '配置项'
  );

  const need = (present: boolean, permission: ExtensionPluginPermission, label: string) => {
    if (present && !permissions.includes(permission))
      errors.push(`${label} 需要权限 ${permission}`);
  };
  need(agentTools.length > 0, 'agent.tool', 'agentTools');
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
      configuration.length > 0)
  )
    errors.push('声明了工具、命令、补全来源、方法或配置项时必须提供 main');

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
      ...(ensoRange ? { ensoRange } : {}),
      ...(main ? { main } : {}),
      ...(renderer ? { renderer } : {}),
      permissions,
      fs,
      net,
      mcp,
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
      },
    },
  };
}
