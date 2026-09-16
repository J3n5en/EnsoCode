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
    id: 'subagent',
    name: 'Subagent',
    description:
      'One-shot subagent: delegate a self-contained task and return a final report (parallel or async)',
  },
  {
    id: 'coworker',
    name: 'Coworker',
    description:
      'Persistent subagent: hire for multi-turn dialogue; you can watch and intervene from a tab',
  },
  { id: 'todo', name: 'Todo', description: 'Task list: track progress on multi-step work' },
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
];

/**
 * 新会话/新安装默认关闭的内置工具。用户打开后从 disabledBuiltinTools 里去掉。
 * memory 默认关闭是产品决策：它依赖的 embedding 模型不随安装包内置，用户启用后才按需下载；
 * 未启用时也不创建 memory.db（见 main/services/memoryHost.ts 的懒开）。
 */
export const DEFAULT_DISABLED_BUILTIN_TOOLS = ['memory'] as const;

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
