import type {
  DefaultModelNotice,
  DefaultModelRef,
  OauthCredentialBlock,
} from '@shared/defaultModel';
import type { Locale } from '@shared/i18n';
import type { ProxyMode } from '@shared/proxy';
import type { StatusLineSegmentId } from '@shared/statusLine';
import type {
  AgentTypeEntry,
  InstructionEntry,
  McpServerEntry,
  ModelProvider,
  Preset,
  Project,
  SkillEntry,
  SubagentModelEntry,
} from '@shared/types';
import type { ThinkingLevel } from '@shared/types/agent';
import type { OauthCredentialSnapshot } from '@/stores/oauthCredentials';

export type DefaultModelRevalidation =
  | {
      status: 'unchanged';
      defaultModel: DefaultModelRef | null;
      writeback: false;
      notice: null;
    }
  | ({
      status: 'deferred';
      defaultModel: DefaultModelRef | null;
      writeback: false;
      notice: null;
    } & OauthCredentialBlock)
  | {
      status: 'stale';
      defaultModel: DefaultModelRef | null;
      writeback: false;
      notice: null;
    }
  | {
      status: 'sanitized';
      defaultModel: DefaultModelRef | null;
      writeback: true;
      notice: DefaultModelNotice;
    };

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

/** 背景图来源：单张图片 / 本地文件夹随机 / 远程 URL */
export type BackgroundSourceType = 'file' | 'folder' | 'url';

/** 背景图填充方式（映射到 background-size/repeat/position） */
export type BackgroundSizeMode = 'cover' | 'contain' | 'repeat' | 'center';

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

  /**
   * 状态栏开启的段位序列。⚠️ **数组顺序即渲染顺序**（段位支持用户拖拽排序）；
   * 关闭的段位直接不在数组里，重新开启时追加到末尾。
   * 权威 id 全集与预设见 `@shared/statusLine`；「当前是哪个预设」由 `statusLinePresetOf`
   * 按序列反推，不额外持久化 preset 字段。
   * ⚠️ 外部可能手改 settings.json，rehydrate 时会做归一化（见 index.ts 的 onRehydrateStorage）。
   */
  statusLineSegments: StatusLineSegmentId[];

  /** 是否让 agent 加载本机 skill（.agents/skills、.pi/skills）；缺省视为 true */
  loadLocalSkills: boolean;

  /** 是否同时加载项目内 .claude/.codex/.cursor 的 skills 与规则文件（.cursorrules、.cursor/rules）；缺省 false */
  loadHarnessAssets: boolean;

  /** 是否自动检查并下载应用更新；缺省 true */
  autoUpdate: boolean;

  /** 网络代理：系统 / 直连 / 自定义；缺省 system */
  proxyMode: ProxyMode;
  /** 自定义代理 URL，仅 custom 模式使用 */
  customProxyUrl: string;

  /** agent 新完成文件改动时打开右侧 Changes；缺省 false */
  openChangesOnFileEdit: boolean;
  /** 只读工具（read/grep/find/ls）一行化 + 进行中的轮也折组；缺省 true */
  compactReadOnlyTools: boolean;

  // 背景图（主窗口生效；渲染见 BackgroundLayer + useBackgroundImage）
  /** 背景图总开关；缺省 false */
  backgroundImageEnabled: boolean;
  backgroundSourceType: BackgroundSourceType;
  /** file 模式：本地图片/视频绝对路径 */
  backgroundImagePath: string;
  /** folder 模式：随机取图的本地目录 */
  backgroundFolderPath: string;
  /** url 模式：http(s) 图片地址（经主进程代理加载） */
  backgroundUrlPath: string;
  /** folder/url 模式下定时自动换图 */
  backgroundRandomEnabled: boolean;
  /** 自动换图间隔（秒），setter 内 clamp 5–86400 */
  backgroundRandomInterval: number;
  /** 背景可见度 0–1；前景面板 alpha = 1 - opacity（背景图本身不变透明） */
  backgroundOpacity: number;
  /** 模糊半径 0–20 px */
  backgroundBlur: number;
  /** 亮度 0–2（1 为原图） */
  backgroundBrightness: number;
  /** 饱和度 0–2（1 为原图） */
  backgroundSaturation: number;
  /** 底部输入框（Composer）的不透明度 0–1，独立于面板 alpha 单独可调 */
  backgroundComposerOpacity: number;
  /** 代码块 / diff 视图的不透明度 0–1，独立可调（保可读性同时透出背景） */
  backgroundCodeOpacity: number;
  backgroundSizeMode: BackgroundSizeMode;
  /**
   * 手动刷新计数器。设置窗口点「立即刷新」时 +1，借设置持久化的多窗口同步
   * 广播传到主窗口，驱动 BackgroundLayer 重新随机选图 / 绕开远程缓存。
   */
  backgroundRefreshNonce: number;

  // Model providers
  providers: ModelProvider[];
  /** 尚未自选模型的新会话与 Enso 共用的全局默认；只保存 provider entry id + model id */
  defaultModel: DefaultModelRef | null;
  /** 会话标题总结：首条用户消息后用小模型生成短标题；缺省关 */
  titleSummaryEnabled: boolean;
  /** 标题总结独立模型；null = 跟随全局默认模型 */
  titleSummaryModel: DefaultModelRef | null;
  /** 新会话默认是否开启推理；缺省 true */
  defaultReasoningEnabled: boolean;
  /** 新会话默认思考深度；缺省 medium */
  defaultThinkingLevel: ThinkingLevel;

  // Skills / MCP servers（按引用登记，内容留在源应用目录）
  skills: SkillEntry[];
  mcpServers: McpServerEntry[];
  instructions: InstructionEntry[];

  // 注入组合预设（默认预设不入库，运行时合成）
  presets: Preset[];
  /** 新会话默认预设；'default' = 内置全局预设（跟随 enabled 开关） */
  defaultPresetId: string;
  agentTypes: AgentTypeEntry[];
  /** 允许主 agent 给 subagent/coworker 指定模型；缺省 false */
  subagentModelsEnabled: boolean;
  /** 子代理可选模型列表（模型 + 选型描述） */
  subagentModels: SubagentModelEntry[];
  /** 被关闭的内置子代理类型（name 集合） */
  disabledBuiltinAgentTypes: string[];
  /** 被关闭的内置工具（id 集合;默认全开） */
  disabledBuiltinTools: string[];

  /** 是否已完成首次运行引导；老用户（已有配置）视为已完成 */
  onboarded: boolean;

  /** 快捷键覆盖(action → 绑定串);只存与默认不同的项 */
  keybindings: Record<string, string>;

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
  setLoadHarnessAssets: (value: boolean) => void;
  setAutoUpdate: (value: boolean) => void;
  setProxyMode: (mode: ProxyMode) => void;
  setCustomProxyUrl: (url: string) => void;
  setOpenChangesOnFileEdit: (value: boolean) => void;
  setCompactReadOnlyTools: (value: boolean) => void;

  // Background image actions（数值 setter 内部 clamp，非法值落回缺省）
  setBackgroundImageEnabled: (value: boolean) => void;
  setBackgroundSourceType: (type: BackgroundSourceType) => void;
  setBackgroundImagePath: (path: string) => void;
  setBackgroundFolderPath: (path: string) => void;
  setBackgroundUrlPath: (url: string) => void;
  setBackgroundRandomEnabled: (value: boolean) => void;
  setBackgroundRandomInterval: (seconds: number) => void;
  setBackgroundOpacity: (opacity: number) => void;
  setBackgroundBlur: (blur: number) => void;
  setBackgroundBrightness: (brightness: number) => void;
  setBackgroundSaturation: (saturation: number) => void;
  setBackgroundComposerOpacity: (opacity: number) => void;
  setBackgroundCodeOpacity: (opacity: number) => void;
  setBackgroundSizeMode: (mode: BackgroundSizeMode) => void;
  /** 手动刷新：nonce +1，经多窗口同步触发主窗口重新取图 */
  bumpBackgroundRefresh: () => void;
  setStatusLineSegments: (segments: StatusLineSegmentId[]) => void;
  toggleStatusLineSegment: (id: StatusLineSegmentId, enabled: boolean) => void;

  // Provider actions
  /** 按 baseUrl+apiKey 指纹（订阅条目按 oauthAccountKey）与现有项去重，返回实际新增数量 */
  addProviders: (providers: ModelProvider[]) => number;
  updateProvider: (id: string, updates: Partial<Omit<ModelProvider, 'id'>>) => void;
  removeProvider: (id: string) => void;

  /** 设置全局默认；只持久化 provider entry id + model id */
  setDefaultModel: (defaultModel: DefaultModelRef | null) => void;
  /** 用当前 OAuth 真凭证快照重校验；非 ready/stale 时绝不写回 */
  revalidateDefaultModel: (snapshot: OauthCredentialSnapshot) => DefaultModelRevalidation;
  setDefaultReasoningEnabled: (value: boolean) => void;
  setDefaultThinkingLevel: (level: ThinkingLevel) => void;
  // Title summary actions
  setTitleSummaryEnabled: (value: boolean) => void;
  /** 设置标题总结独立模型；null = 回到跟随全局默认 */
  setTitleSummaryModel: (model: DefaultModelRef | null) => void;
  // Skill actions
  /** 按技能目录路径去重，返回实际新增数量 */
  addSkills: (skills: SkillEntry[]) => number;
  updateSkill: (id: string, updates: Partial<Omit<SkillEntry, 'id'>>) => void;
  /** 一次写入筛选结果的 enabled，避免逐条 persist */
  setSkillsEnabled: (ids: string[], enabled: boolean) => void;
  removeSkill: (id: string) => void;

  // MCP actions
  /** 按启动命令或 URL 去重，返回实际新增数量 */
  addMcpServers: (servers: McpServerEntry[]) => number;
  updateMcpServer: (id: string, updates: Partial<Omit<McpServerEntry, 'id'>>) => void;
  /** 一次写入筛选结果的 enabled，避免逐条 persist */
  setMcpServersEnabled: (ids: string[], enabled: boolean) => void;
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
  setDefaultPresetId: (id: string) => void;

  // Subagent model actions
  setSubagentModelsEnabled: (value: boolean) => void;
  addSubagentModel: (entry: Omit<SubagentModelEntry, 'id'>) => SubagentModelEntry;
  updateSubagentModel: (id: string, updates: Partial<Omit<SubagentModelEntry, 'id'>>) => void;
  removeSubagentModel: (id: string) => void;

  // Agent type actions
  addAgentType: (entry: Omit<AgentTypeEntry, 'id'>) => AgentTypeEntry;
  updateAgentType: (id: string, updates: Partial<Omit<AgentTypeEntry, 'id'>>) => void;
  removeAgentType: (id: string) => void;
  toggleBuiltinAgentType: (name: string, enabled: boolean) => void;
  toggleBuiltinTool: (id: string, enabled: boolean) => void;

  // Onboarding
  setOnboarded: (value: boolean) => void;

  // Keybinding actions
  setKeybinding: (action: string, binding: string) => void;
  resetKeybinding: (action: string) => void;

  // Project actions
  /** Main authority创建project并返回canonical projection。 */
  /** remote 传入时创建 ssh 远程项目;创建被拒(含远端探测失败)时抛 Error(message 可直接展示) */
  addProject: (path: string, remote?: { sshConnectionId: string }) => Promise<Project | null>;
  removeProject: (id: string) => Promise<boolean>;
}
