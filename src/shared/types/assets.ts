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

/** 全局指令 / 记忆文件：CLAUDE.md、AGENTS.md、GEMINI.md、SOUL.md 等 */
export interface InstructionEntry {
  id: string;
  /** 文件名或条目名 */
  name: string;
  /** 文件路径；来自数据库的内联条目为空 */
  path?: string;
  /** 无文件来源（如 CC Switch prompts）直接保存内容 */
  content?: string;
  source: string;
  bytes: number;
  enabled: boolean;
}
