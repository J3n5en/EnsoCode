/** 内置工具:设置页可开关,默认全开;禁用后不下发给会话(模型看不到) */
export interface BuiltinToolInfo {
  /** 稳定 id,用于开关持久化与下发过滤 */
  id: string;
  name: string;
  description: string;
}

export const BUILTIN_TOOLS: BuiltinToolInfo[] = [
  {
    id: 'subagent',
    name: 'Subagent',
    description: '一次性子代理:委派自包含子任务,返回最终报告(可并行、可异步)',
  },
  {
    id: 'coworker',
    name: 'Coworker',
    description: '持久子代理:雇佣后多轮对话,用户可在 tab 旁观介入',
  },
  { id: 'todo', name: 'Todo', description: '任务清单:跟踪多步骤工作的进度' },
  { id: 'ask_user', name: 'Ask user', description: '向用户提问并等待回答(带选项/超时)' },
  {
    id: 'background_tasks',
    name: 'Background tasks',
    description: '后台 shell 任务:长命令挂后台跑,完成时通知',
  },
];
