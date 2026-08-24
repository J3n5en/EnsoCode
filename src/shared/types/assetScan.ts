import type { InstructionEntry, McpServerEntry, SkillEntry } from './assets';

/** 支持扫描的技能 / MCP / 指令文件来源 */
export const ASSET_SOURCE_IDS = [
  'claude-code',
  'claude-plugins',
  'claude-desktop',
  'codex',
  'cursor',
  'gemini',
  'grok',
  'factory',
  'opencode',
  'cc-switch',
] as const;
export type AssetSourceId = (typeof ASSET_SOURCE_IDS)[number];

export type AssetSourceStatus = 'found' | 'not-found' | 'read-error';

export interface AssetSourceReport {
  sourceId: AssetSourceId;
  sourceName: string;
  status: AssetSourceStatus;
  /** 展示用路径 */
  configPath: string;
  skillCount: number;
  mcpCount: number;
  instructionCount: number;
}

/** 重复原因：已登记过 / 与本轮更前面的来源内容相同 / 同名 */
export type DuplicateReason = 'registered' | 'same-content' | 'same-name';

interface CandidateBase {
  id: string;
  sourceId: AssetSourceId;
  /** 分组展示名（插件来源为具体插件名） */
  groupName: string;
  name: string;
  /** 与已登记项或本轮其他来源重复 */
  duplicated: boolean;
  duplicateReason?: DuplicateReason;
}

export interface SkillCandidate extends CandidateBase {
  kind: 'skill';
  description: string;
  path: string;
}

export interface McpCandidate extends CandidateBase {
  kind: 'mcp';
  transport: 'stdio' | 'http' | 'sse';
  /** 命令行或 URL 的展示摘要 */
  summary: string;
  /** 仅暴露 env 键名，值留在主进程 */
  envKeys: string[];
}

export interface InstructionCandidate extends CandidateBase {
  kind: 'instruction';
  /** 展示用位置：文件路径，或数据库内联条目的说明 */
  location: string;
  bytes: number;
}

export type AssetCandidate = SkillCandidate | McpCandidate | InstructionCandidate;

export interface LocalAssetScanResult {
  scanId: string;
  sources: AssetSourceReport[];
  candidates: AssetCandidate[];
}

export type CollectedSkill = Omit<SkillEntry, 'id' | 'enabled'> & {
  candidateId: string;
  kind: 'skill';
};

export type CollectedMcpServer = Omit<McpServerEntry, 'id' | 'enabled'> & {
  candidateId: string;
  kind: 'mcp';
};

export type CollectedInstruction = Omit<InstructionEntry, 'id' | 'enabled' | 'bytes' | 'local'> & {
  candidateId: string;
  kind: 'instruction';
  bytes: number;
  /** 无文件来源（如 CC Switch prompts）的内容，导入时直接落成本地副本 */
  content?: string;
};

export type CollectedAsset = CollectedSkill | CollectedMcpServer | CollectedInstruction;
