import type { Locale } from '@shared/i18n';
import type { InstructionEntry, McpServerEntry, ModelProvider, SkillEntry } from '@shared/types';

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

  // Model providers
  providers: ModelProvider[];

  // Skills / MCP servers（按引用登记，内容留在源应用目录）
  skills: SkillEntry[];
  mcpServers: McpServerEntry[];
  instructions: InstructionEntry[];

  // Setters
  setTheme: (theme: Theme) => void;
  setLanguage: (language: Locale) => void;
  setTerminalTheme: (theme: string) => void;
  setTerminalFontSize: (size: number) => void;
  setTerminalFontFamily: (family: string) => void;
  setTerminalFontWeight: (weight: FontWeight) => void;
  setTerminalFontWeightBold: (weight: FontWeight) => void;
  toggleFavoriteTerminalTheme: (theme: string) => void;

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
}
