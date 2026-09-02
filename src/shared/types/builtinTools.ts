/** 内置工具:设置页可开关,默认全开;禁用后不下发给会话(模型看不到) */
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
];
