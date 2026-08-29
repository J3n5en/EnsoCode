/** 技能与 MCP 服务器：均以引用方式登记，内容留在源应用目录 */

export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  /** 技能目录绝对路径（内容不复制，按引用使用） */
  path: string;
  /** 来源展示名，如 Claude Code、插件名 */
  source: string;
  enabled: boolean;
}

export const MCP_TRANSPORTS = ['stdio', 'http', 'sse'] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export interface McpServerEntry {
  id: string;
  name: string;
  transport: McpTransport;
  /** stdio 用 */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http/sse 用 */
  url?: string;
  source: string;
  enabled: boolean;
}

/** 注入组合预设：会话级选用的 skill/MCP/指令文件集合。
 *  默认预设不入库（DEFAULT_PRESET_ID 运行时合成，语义 = 跟随各条目的 enabled 开关）；
 *  自定义预设按 id 显式集合过滤，忽略条目自身 enabled */
export interface Preset {
  id: string;
  name: string;
  skillIds: string[];
  mcpServerIds: string[];
  /** 注入的指令文件（单主源）；不选则不注入 */
  instructionId?: string;
}

export const DEFAULT_PRESET_ID = 'default';

/** 内置 subagent 类型（默认启用,可关闭不可删；模型跟随会话） */
export const BUILTIN_AGENT_TYPES: Omit<AgentTypeEntry, 'id'>[] = [
  {
    name: 'scout',
    description: 'Fast read-only recon; returns compressed findings',
    systemPrompt:
      'You are a fast reconnaissance agent. Read and search only — never modify files or run commands with side effects. ' +
      'Return a compact, well-structured report of findings with concrete file paths.',
    tools: 'readonly',
  },
  {
    name: 'worker',
    description: 'Implements a self-contained coding subtask end to end',
    systemPrompt:
      'You are an implementation agent. Complete the assigned coding subtask end to end: read the relevant code, ' +
      'make the changes, and verify them (typecheck/tests where available). Report what you changed and any follow-ups.',
    tools: 'all',
  },
  {
    name: 'reviewer',
    description: 'Reviews code or diffs; read-only, returns prioritized issues',
    systemPrompt:
      'You are a code review agent. Read the relevant code or diff and return a prioritized list of concrete issues ' +
      '(correctness first), each with file:line and a suggested fix. Do not modify anything.',
    tools: 'readonly',
  },
];

/** 自定义 subagent 类型：绑定系统提示/模型/工具集,经 subagent 工具的 agent_type 参数选用 */
export interface AgentTypeEntry {
  id: string;
  /** slug（工具参数值,如 scout） */
  name: string;
  /** 模型选型依据（注入工具描述） */
  description: string;
  /** 子会话系统提示（前置进任务 prompt） */
  systemPrompt: string;
  /** 绑定模型；缺省 = 跟随父会话 */
  providerId?: string;
  modelId?: string;
  /** 工具集：all 全部 / readonly 仅只读（read+grep/find/ls,无 bash/edit/write/MCP） */
  tools: 'all' | 'readonly';
  /** 启用的 skill（按 SkillEntry id 精选；缺省无） */
  skillIds?: string[];
  /** 启用的 MCP server（按 McpServerEntry id 精选；缺省无） */
  mcpServerIds?: string[];
}

/**
 * 子代理可选模型条目（设置页「允许子代理指定模型」列表）。
 * 只存 provider entry id + model id，凭证由 main 在 spawn 时解析；
 * description 是选型依据，注入 subagent/coworker 工具的 model 参数说明。
 */
export interface SubagentModelEntry {
  id: string;
  providerId: string;
  modelId: string;
  description: string;
}

/** 全局指令 / 记忆文件：CLAUDE.md、AGENTS.md、GEMINI.md、SOUL.md 等
 *  默认指向源应用的原文件（跟随其更新）；一旦在应用内编辑，
 *  先复制为本地副本再改，不回写源文件 */
export interface InstructionEntry {
  id: string;
  /** 条目名，可重命名 */
  name: string;
  /** 来源展示名 */
  source: string;
  /** 原文件路径；无文件来源（如 CC Switch prompts）为空 */
  sourcePath?: string;
  /** true 表示内容已复制到 userData/instructions/<id>.md，不再跟随源文件 */
  local: boolean;
  bytes: number;
  enabled: boolean;
}
