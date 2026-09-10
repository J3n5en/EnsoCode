import type { DefaultModelRef } from '@shared/defaultModel';
import type { Locale } from '@shared/i18n';
import type { SmartCompactMode } from '@shared/smartCompactMode';
import type { StatusLineSegmentId } from '@shared/statusLine';
import type {
  AgentTypeEntry,
  InstructionEntry,
  McpServerEntry,
  ModelProvider,
  Preset,
  SkillEntry,
  SubagentModelEntry,
  ThinkingLevel,
} from '@shared/types';
import type { PricingTable } from '@shared/usage/pricing';

export const CONFIG_SYNC_PROVIDER_OMISSIONS = [
  'apiKey',
  'oauthAccountKey',
  'baseUrlCredentials',
  'baseUrlQuery',
  'baseUrlFragment',
] as const;
export type ConfigSyncProviderOmission = (typeof CONFIG_SYNC_PROVIDER_OMISSIONS)[number];

export const CONFIG_SYNC_MCP_OMISSIONS = [
  'args',
  'env',
  'urlCredentials',
  'urlQuery',
  'urlFragment',
] as const;
export type ConfigSyncMcpOmission = (typeof CONFIG_SYNC_MCP_OMISSIONS)[number];

/** 可移植 provider；明文包可省略凭证，并通过 omittedFields 记录。 */
export interface ConfigSyncProvider extends Omit<ModelProvider, 'apiKey' | 'oauthAccountKey'> {
  apiKey?: string;
  oauthAccountKey?: string;
  omittedFields?: ConfigSyncProviderOmission[];
}

/** 可移植 MCP；明文包可省略敏感启动参数，并通过 omittedFields 记录。 */
export interface ConfigSyncMcpServer extends Omit<McpServerEntry, 'args' | 'env'> {
  args?: string[];
  env?: Record<string, string>;
  omittedFields?: ConfigSyncMcpOmission[];
}

/** 技能源路径不进入配置包；导入阶段会为 path 写入受控本机路径。 */
export interface ConfigSyncSkill extends Omit<SkillEntry, 'path'> {
  /** 外部输入类型保持可构造；codec 在信任边界强制要求空字符串。 */
  path: string;
}

/** 指令源路径不进入配置包；导入阶段会为 sourcePath 写入受控本机路径。 */
export interface ConfigSyncInstruction extends Omit<InstructionEntry, 'sourcePath'> {
  sourcePath?: '';
}

export interface ConfigSyncState {
  providers: ConfigSyncProvider[];
  skills: ConfigSyncSkill[];
  mcpServers: ConfigSyncMcpServer[];
  instructions: ConfigSyncInstruction[];
  presets: Preset[];
  agentTypes: AgentTypeEntry[];
  subagentModels: SubagentModelEntry[];
  defaultModel?: DefaultModelRef | null;
  titleSummaryModel?: DefaultModelRef | null;
  memoryDistillModel?: DefaultModelRef | null;
  memoryChatModel?: string;
  memoryLanguage?: string;
  smartCompactModel?: DefaultModelRef | null;
  approvalReviewer?: DefaultModelRef | null;
  titleSummaryEnabled?: boolean;
  smartCompactEnabled?: boolean;
  smartCompactMode?: SmartCompactMode;
  /** 记忆向量模型注册表 id（`none` / `local:*` / `remote:*`） */
  memoryEmbeddingModel?: string;
  /** 会话结束后是否用 LLM 自动蒸馏长期记忆；缺省关 */
  memoryDistillEnabled?: boolean;
  /** 记忆创建后是否用 LLM 异步抽取实体图谱；缺省关 */
  memoryKgEnabled?: boolean;
  defaultReasoningEnabled?: boolean;
  defaultThinkingLevel?: ThinkingLevel;
  defaultPresetId?: string;
  subagentModelsEnabled?: boolean;
  disabledBuiltinAgentTypes?: string[];
  disabledBuiltinTools?: string[];
  theme?: 'light' | 'dark' | 'system' | 'sync-terminal';
  language?: Locale;
  terminalTheme?: string;
  terminalFontSize?: number;
  terminalFontFamily?: string;
  terminalFontWeight?:
    | 'normal'
    | 'bold'
    | '100'
    | '200'
    | '300'
    | '400'
    | '500'
    | '600'
    | '700'
    | '800'
    | '900';
  terminalFontWeightBold?:
    | 'normal'
    | 'bold'
    | '100'
    | '200'
    | '300'
    | '400'
    | '500'
    | '600'
    | '700'
    | '800'
    | '900';
  favoriteTerminalThemes?: string[];
  statusLineSegments?: StatusLineSegmentId[];
  loadLocalSkills?: boolean;
  loadHarnessAssets?: boolean;
  exploreFoldEnabled?: boolean;
  bashInterceptEnabled?: boolean;
  hashlineEditEnabled?: boolean;
  openChangesOnFileEdit?: boolean;
  compactReadOnlyTools?: boolean;
  expandLiveEdits?: boolean;
  chatWide?: boolean;
  notifyMainAgentOnly?: boolean;
  maxActiveCoworkers?: number;
  generationStallTimeoutMin?: number;
  autoArchiveIdleDays?: number;
  autoArchiveMergedWorktrees?: boolean;
  autoDeleteArchivedDays?: number;
  backgroundRandomInterval?: number;
  backgroundOpacity?: number;
  backgroundBlur?: number;
  backgroundBrightness?: number;
  backgroundSaturation?: number;
  backgroundComposerOpacity?: number;
  backgroundCodeOpacity?: number;
  backgroundSizeMode?: 'cover' | 'contain' | 'repeat' | 'center';
  keybindings?: Record<string, string>;
  usageModelPricing?: PricingTable;
}

export interface ConfigSyncSkillFile {
  /** POSIX 相对路径；content 是规范 base64。 */
  path: string;
  content: string;
  executable?: boolean;
}

export interface ConfigSyncSkillResource {
  id: string;
  files: ConfigSyncSkillFile[];
}

export interface ConfigSyncInstructionResource {
  id: string;
  content: string;
}

export interface ConfigSyncBundle {
  format: 'enso-config';
  version: 1;
  createdAt: string;
  state: ConfigSyncState;
  resources: {
    skills: ConfigSyncSkillResource[];
    instructions: ConfigSyncInstructionResource[];
  };
  secretsIncluded: boolean;
}
