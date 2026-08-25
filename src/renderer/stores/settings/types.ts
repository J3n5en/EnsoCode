import type { Locale } from '@shared/i18n';
import type {
  AgentTypeEntry,
  InstructionEntry,
  McpServerEntry,
  ModelProvider,
  Preset,
  Project,
  SkillEntry,
} from '@shared/types';

export type Theme = 'light' | 'dark' | 'system' | 'sync-terminal';

export type FontWeight =
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

export interface SettingsState {
  // UI
  theme: Theme;
  language: Locale;

  // Terminal appearance
  terminalTheme: string;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalFontWeight: FontWeight;
  terminalFontWeightBold: FontWeight;
  favoriteTerminalThemes: string[];

  /** 是否让 agent 加载本机 skill（.agents/skills、.pi/skills）；缺省视为 true */
  loadLocalSkills: boolean;

  // Model providers
  providers: ModelProvider[];

  // Skills / MCP servers（按引用登记，内容留在源应用目录）
  skills: SkillEntry[];
  mcpServers: McpServerEntry[];
  instructions: InstructionEntry[];

  // 注入组合预设（默认预设不入库，运行时合成）
  presets: Preset[];
  agentTypes: AgentTypeEntry[];

  /** 是否已完成首次运行引导；老用户（已有配置）视为已完成 */
  onboarded: boolean;

  // Projects（本地目录引用，作为会话工作目录）
  projects: Project[];

  // Setters
  setTheme: (theme: Theme) => void;
  setLanguage: (language: Locale) => void;
  setTerminalTheme: (theme: string) => void;
  setTerminalFontSize: (size: number) => void;
  setTerminalFontFamily: (family: string) => void;
  setTerminalFontWeight: (weight: FontWeight) => void;
  setTerminalFontWeightBold: (weight: FontWeight) => void;
  toggleFavoriteTerminalTheme: (theme: string) => void;
  setLoadLocalSkills: (value: boolean) => void;

  // Provider actions
  /** 按 baseUrl+apiKey 指纹与现有项去重，返回实际新增数量 */
  addProviders: (providers: ModelProvider[]) => number;
  updateProvider: (id: string, updates: Partial<Omit<ModelProvider, 'id'>>) => void;
  removeProvider: (id: string) => void;

  // Skill actions
  /** 按技能目录路径去重，返回实际新增数量 */
  addSkills: (skills: SkillEntry[]) => number;
  updateSkill: (id: string, updates: Partial<Omit<SkillEntry, 'id'>>) => void;
  removeSkill: (id: string) => void;

  // MCP actions
  /** 按启动命令或 URL 去重，返回实际新增数量 */
  addMcpServers: (servers: McpServerEntry[]) => number;
  updateMcpServer: (id: string, updates: Partial<Omit<McpServerEntry, 'id'>>) => void;
  removeMcpServer: (id: string) => void;

  // Instruction file actions
  /** 按文件路径去重，返回实际新增数量 */
  addInstructions: (instructions: InstructionEntry[]) => number;
  updateInstruction: (id: string, updates: Partial<Omit<InstructionEntry, 'id'>>) => void;
  removeInstruction: (id: string) => void;

  // Preset actions
  addPreset: (preset: Omit<Preset, 'id'>) => Preset;
  updatePreset: (id: string, updates: Partial<Omit<Preset, 'id'>>) => void;
  removePreset: (id: string) => void;

  // Agent type actions
  addAgentType: (entry: Omit<AgentTypeEntry, 'id'>) => AgentTypeEntry;
  updateAgentType: (id: string, updates: Partial<Omit<AgentTypeEntry, 'id'>>) => void;
  removeAgentType: (id: string) => void;

  // Onboarding
  setOnboarded: (value: boolean) => void;

  // Project actions
  /** 按目录路径去重；已存在时返回已有项 */
  addProject: (path: string) => Project;
  removeProject: (id: string) => void;
}
