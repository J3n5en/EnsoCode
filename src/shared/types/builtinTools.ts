import { parseWebSearchChain } from '../webSearchChain';

/** 内置工具:设置页可开关;禁用后不下发给会话(模型看不到)。默认开关见 DEFAULT_DISABLED_BUILTIN_TOOLS。 */
export interface BuiltinToolInfo {
  /** 稳定 id,用于开关持久化与下发过滤 */
  id: string;
  name: string;
  /** i18n key（英文原文）；模块级不能调 hook，设置页消费侧 t() */
  description: string;
}

export const BUILTIN_TOOLS: BuiltinToolInfo[] = [
  {
    id: 'image_generation',
    name: 'ImageGen',
    description:
      'Generate images with the configured image model and save them to the session scratch directory',
  },
  {
    id: 'subagent',
    name: 'Subagent',
    description:
      'Unified agents: delegate one-shot tasks or keep persistent coworkers under Main control',
  },
  {
    id: 'workflow',
    name: 'Workflow',
    description:
      'Run a JavaScript workflow that fans work out across subagents. Live status appears in the side panel.',
  },
  { id: 'todo', name: 'Todo', description: 'Task list: track progress on multi-step work' },
  {
    id: 'plan',
    name: 'Plan mode',
    description:
      'Plan mode: research read-only, submit a plan for approval, then carry it out after approval',
  },
  {
    id: 'ask_user',
    name: 'Ask user',
    description: 'Ask the user a question and wait for an answer (options / timeout)',
  },
  {
    id: 'browser',
    name: 'Browser',
    description:
      "Built-in browser: open pages in Enso's own Chromium, read snapshots, click and type by ref",
  },
  {
    id: 'web',
    name: 'Web search',
    description:
      "Web search and fetch: search with the session model's built-in search (falls back to a keyless service) and read public pages as markdown",
  },
  {
    id: 'background_tasks',
    name: 'Background tasks',
    description:
      'Background shell task: run long commands in the background and notify on completion',
  },
  {
    id: 'memory',
    name: 'Memory',
    description:
      'Long-term memory: the agent can search, capture and consolidate durable decisions, preferences and lessons across sessions',
  },
  {
    id: 'isolated_sandbox',
    name: 'Isolated sandbox',
    description:
      'Run JavaScript in an isolated sandbox that can call session tools. Intermediate reads and edits stay out of the chat; only the returned value is added to the conversation.',
  },
  {
    id: 'computer',
    name: 'Computer',
    description:
      'Host desktop: list windows, screenshot, accessibility tree, and input. Default off. Not the built-in browser.',
  },
];

/**
 * 新会话/新安装默认关闭的内置工具。用户打开后从 disabledBuiltinTools 里去掉。
 * memory 默认关闭是产品决策：它依赖的 embedding 模型不随安装包内置。
 * computer 默认关闭：桌面键鼠不可回滚，需显式打开并授予系统权限。
 */
export const DEFAULT_DISABLED_BUILTIN_TOOLS = ['memory', 'computer'] as const;

/** 引入 computer 的设置版本；更早落盘的禁用列表不含它，按默认关闭补齐 */
export const COMPUTER_DEFAULT_OFF_SETTINGS_VERSION = 14;

function withComputerDisabled(entry: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(entry.disabledBuiltinTools)) return entry;
  const list = entry.disabledBuiltinTools.filter((id): id is string => typeof id === 'string');
  return list.includes('computer')
    ? entry
    : { ...entry, disabledBuiltinTools: [...list, 'computer'] };
}

/** 旧版本已落盘的禁用列表（全局与项目覆盖）补上 computer；缺字段不捏造（走默认）。 */
export function addComputerDefaultOff(state: Record<string, unknown>): Record<string, unknown> {
  const migrated = withComputerDisabled(state);
  if (!Array.isArray(migrated.projects)) return migrated;
  return {
    ...migrated,
    projects: migrated.projects.map((project) =>
      project && typeof project === 'object' && !Array.isArray(project)
        ? withComputerDisabled(project as Record<string, unknown>)
        : project
    ),
  };
}

/**
 * Main 直读 `enso-settings` 持久化条目：renderer 迁移结果可能尚未写回磁盘，
 * computer 默认关必须 fail-closed，不能因旧落盘列表缺项而被静默打开。
 */
export function persistedSettingsState(persisted: unknown): Record<string, unknown> | undefined {
  if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted)) return undefined;
  const { state, version } = persisted as { state?: unknown; version?: unknown };
  if (!state || typeof state !== 'object' || Array.isArray(state)) return undefined;
  const current = typeof version === 'number' ? version : 0;
  const record = state as Record<string, unknown>;
  const base =
    current < COMPUTER_DEFAULT_OFF_SETTINGS_VERSION ? addComputerDefaultOff(record) : record;
  // web_search 候选链：只在字段存在时收窄（不向老数据注入新键，保持形状逐字节稳定）；
  // 缺省读取方（pushWebSearchConfig 等）自行 parseWebSearchChain(undefined) → 空链
  if (base.webSearchChain === undefined) return base;
  return { ...base, webSearchChain: parseWebSearchChain(base.webSearchChain) };
}

export function effectiveSubagentAllowedModes(
  configured: unknown,
  disabledBuiltinTools: unknown
): Array<'task' | 'coworker'> {
  if (Array.isArray(configured)) {
    const selected = new Set(
      configured.filter(
        (mode): mode is 'task' | 'coworker' => mode === 'task' || mode === 'coworker'
      )
    );
    return (['task', 'coworker'] as const).filter((mode) => selected.has(mode));
  }
  const disabled = new Set(
    Array.isArray(disabledBuiltinTools)
      ? disabledBuiltinTools.filter((id): id is string => typeof id === 'string')
      : []
  );
  return (['task', 'coworker'] as const).filter(
    (mode) => !disabled.has(mode === 'task' ? 'subagent' : 'coworker')
  );
}

/** Main 直读磁盘时把未知形状收成 string[]；缺字段走默认关闭列表（空 = 全开）。 */
export function effectiveDisabledBuiltinTools(disabled: unknown): string[] {
  return Array.isArray(disabled)
    ? disabled.filter((id): id is string => typeof id === 'string')
    : [...DEFAULT_DISABLED_BUILTIN_TOOLS];
}

/** 项目覆盖优先于全局；未覆盖或字段不是数组则跟全局。 */
export function resolveDisabledBuiltinTools(
  globalDisabled: unknown,
  project?: { disabledBuiltinTools?: unknown } | null
): string[] {
  return Array.isArray(project?.disabledBuiltinTools)
    ? effectiveDisabledBuiltinTools(project.disabledBuiltinTools)
    : effectiveDisabledBuiltinTools(globalDisabled);
}

/** workflow 靠 subagent 派发子代理，两者都开才会下发给会话（与 worker 口径一致） */
export function isWorkflowAvailable(disabledBuiltinTools: readonly string[]): boolean {
  return !disabledBuiltinTools.includes('workflow') && !disabledBuiltinTools.includes('subagent');
}

export function isBuiltinToolEnabledForProject(
  globalDisabled: unknown,
  projects: unknown,
  projectId: string | undefined,
  toolId: string
): boolean {
  return !resolveDisabledBuiltinTools(globalDisabled, {
    disabledBuiltinTools: projectDisabledBuiltinTools(projects, projectId),
  }).includes(toolId);
}

/** 从 settings.projects 取出某项目的覆盖列表；缺项目或未覆盖返回 undefined。 */
export function projectDisabledBuiltinTools(
  projects: unknown,
  projectId: string | undefined
): unknown {
  if (!projectId || !Array.isArray(projects)) return undefined;
  for (const entry of projects) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as { id?: unknown; disabledBuiltinTools?: unknown };
    if (record.id === projectId) return record.disabledBuiltinTools;
  }
  return undefined;
}
