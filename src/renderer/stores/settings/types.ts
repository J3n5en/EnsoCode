import type { CompactStrategy } from '@shared/compactStrategy';
import type {
  DefaultModelNotice,
  DefaultModelRef,
  OauthCredentialBlock,
} from '@shared/defaultModel';
import type { Locale } from '@shared/i18n';
import type { ProxyMode } from '@shared/proxy';
import type { StatusLineSegmentId } from '@shared/statusLine';
import type { TerminalShell } from '@shared/terminalShell';
import type {
  AgentTypeEntry,
  EditMode,
  InstructionEntry,
  McpServerEntry,
  ModelProvider,
  PluginEntry,
  Preset,
  Project,
  ProjectGroup,
  SkillEntry,
  SubagentModelEntry,
} from '@shared/types';
import type { AgentMode, ApprovalMode, ThinkingLevel } from '@shared/types/agent';
import type { SpeechModelId } from '@shared/types/speech';
import type { ModelPricing, PricingTable } from '@shared/usage/pricing';
import type { VirtualClassifierConfig, VirtualModelEntry } from '@shared/virtualModels';
import type { WindowsLocalShell } from '@shared/windowsLocalShell';
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

export { ACCENT_COLORS, type AccentColor } from '@shared/accentColor';

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
  /** 界面强调色；写入 `html[data-accent]`，缺省 violet */
  accentColor: import('@shared/accentColor').AccentColor;
  language: Locale;

  // Terminal appearance
  terminalTheme: string;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalFontWeight: FontWeight;
  terminalFontWeightBold: FontWeight;
  terminalShell: TerminalShell;
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

  /** Windows 本地 agent 命令壳；auto=本机 PowerShell。SSH/非 Windows 忽略。 */
  windowsLocalShell: WindowsLocalShell;

  /** 隔离会话 worktree 的根目录（绝对路径）；'' = userData/worktrees。设备本地，不参与 config-sync */
  worktreeRoot: string;

  /** 探后折叠：模型可 explore_mark / explore_fold；缺省关 */
  exploreFoldEnabled: boolean;

  /** RTK 命令压缩；缺省开，新建或冷恢复会话生效。 */
  rtkEnabled: boolean;

  /** Code 会话也启用受保护动作底线（Bot 会话恒开）；缺省关，新建或冷恢复会话生效。 */
  protectedActionsInCode: boolean;

  /** 文件编辑工具模式；缺省 apply_patch，新建或冷恢复会话生效。 */
  editMode: EditMode;

  /** 上下文压缩策略；缺省 standard，新会话生效。 */
  compactStrategy: CompactStrategy;
  /** 旧设置兼容：rehydrate 后由策略选择取代。 */
  smartCompactEnabled: boolean;
  /** 智能压缩独立模型；null = 跟随当前会话模型 */
  smartCompactModel: DefaultModelRef | null;
  /** 验证式压缩档位；缺省 auto */
  smartCompactMode: import('@shared/smartCompactMode').SmartCompactMode;

  /** 记忆向量模型注册表 id（none / local:* / remote:*）；模型文件在 userData，这里只存 id */
  memoryEmbeddingModel: string;
  /** 本地模型未就绪时是否后台下载；设备本地，缺省关 */
  memoryEmbeddingAutoDownload: boolean;
  /** 本地记忆模型空闲卸载分钟数；5/10/30，0 = 永不，缺省 10 */
  memoryModelIdleMinutes: number;
  /** remote:* 模型使用哪个已配置 provider 的 baseUrl/apiKey；设备本地 */
  memoryEmbeddingRemoteProviderId: string | null;
  /** 会话结束后是否用 LLM 自动蒸馏长期记忆；缺省关（只想手动记忆的用户保持关闭） */
  memoryDistillEnabled: boolean;
  /** 记忆创建后是否用 LLM 异步抽取实体图谱；缺省关 */
  memoryKgEnabled: boolean;
  /** 语音输入：开启后才提示下载本地识别模型；缺省关 */
  voiceInputEnabled: boolean;
  /** 实验功能：Bot 模式；缺省关，关闭时 Main 不启动 Bot 后台逻辑 */
  botModeEnabled: boolean;
  /** Bot 群聊智能选人的分类来源；null 走标题模型回退链 judge */
  botRouteClassifier: VirtualClassifierConfig | null;
  /** Bot 辅助任务（自动设置能力等）用的模型；null 跟随默认模型 */
  botAssistantModel: DefaultModelRef | null;
  /** 桌面录音用的麦克风设备 id；SYSTEM_MICROPHONE 跟随系统 */
  voiceInputDevice: string;
  /** 本机语音识别模型 */
  voiceModel: SpeechModelId;
  /** 识别后用 LLM 纠错；缺省关 */
  voiceCorrectionEnabled: boolean;
  /** 纠错后端：'remote' 或本地 chat 模型 id */
  voiceCorrectionModel: string;
  /** 纠错走远程时的模型；null 跟随标题模型 */
  voiceCorrectionRemoteModel: DefaultModelRef | null;
  /** 云端识别的自定义词表，逐行或逗号分隔 */
  voiceVocabulary: string;
  /** 云端识别（Gemini Live）的 API Key */
  voiceGeminiApiKey: string;

  /** 是否自动检查并下载应用更新；缺省 true */
  autoUpdate: boolean;
  /** 包已下好且空闲连续 5 分钟后自动重启安装；缺省关 */
  autoRestartWhenIdle: boolean;

  /** 网络代理：系统 / 直连 / 自定义；缺省 system */
  proxyMode: ProxyMode;
  /** 自定义代理 URL，仅 custom 模式使用 */
  customProxyUrl: string;

  /** agent 新完成文件改动时打开右侧 Changes；缺省 false */
  openChangesOnFileEdit: boolean;
  /** 只读工具（read/grep/find/ls）一行化 + 进行中的轮也折组；缺省 true */
  compactReadOnlyTools: boolean;
  /** agent 运行中 edit/write 的行到位时自动展开 diff/内容；缺省 true */
  expandLiveEdits: boolean;
  /** 推理流式输出时自动展开思考块，结束后仍收起；缺省 true，与改前行为一致 */
  expandLiveReasoning: boolean;
  /** 发送新消息后自动折叠历史轮次，只留最后一轮展开；缺省 false */
  autoCollapseTurns: boolean;
  /** 回答完成后把连续的思考与工具调用折成一行过程摘要 */
  collapseCompletedActivity: boolean;
  /** 输入框上方固定显示最新 todo 清单（仍有未完成项时）；缺省 true */
  pinUnfinishedTodos: boolean;
  /** 聊天列铺满：去掉两侧阶梯 max-w；缺省 false（居中阅读宽度） */
  chatWide: boolean;
  /** 仅主 agent 发送完成/失败通知；coworker 提问/审批仍提醒；缺省 true */
  notifyMainAgentOnly: boolean;
  /** 同一父会话同时在编 coworker 上限；缺省 5，范围 1–20 */
  maxActiveCoworkers: number;
  /** SSH 远端单次命令超时（秒）；缺省 30，范围 5–300 */
  sshTimeoutSeconds: number;
  /** 无 token/工具结果超过此时长则中止；0 = 永不；单位分钟 */
  generationStallTimeoutMin: number;
  /** 闲置超过此天数自动归档；0 = 永不；缺省 30 */
  autoArchiveIdleDays: number;
  /** 已合并 worktree 清理并归档；缺省关 */
  autoArchiveMergedWorktrees: boolean;
  /** 归档超过此天数自动删除；0 = 永不；缺省 0 */
  autoDeleteArchivedDays: number;

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
  /** 新会话跟随聊天里最后一次选的模型；缺省关（钉死当前 defaultModel） */
  defaultModelFollowLast: boolean;
  /** 会话标题总结：首条用户消息后用小模型生成短标题；缺省关 */
  titleSummaryEnabled: boolean;
  /** 标题总结独立模型；null = 跟随全局默认模型 */
  titleSummaryModel: DefaultModelRef | null;
  /** 记忆提炼模型；null = 跟随标题模型 → 全局默认的既有回退链 */
  memoryDistillModel: DefaultModelRef | null;
  /** 记忆补全走远程还是本地 GGUF；`remote` 或 `local:*` 注册表 id */
  memoryChatModel: string;
  /** 提炼出的记忆用什么语言写；缺省英文（检索与去重都对英文更稳） */
  memoryLanguage: string;
  /** 助手代审模型；null = 该档不可用 */
  approvalReviewer: DefaultModelRef | null;
  /** 上次选的审批档；null = 新会话仍按代审可用性默认 */
  lastApprovalMode: ApprovalMode | null;
  /** 新会话默认是否开启推理；缺省 true */
  defaultReasoningEnabled: boolean;
  /** 新会话默认思考深度；缺省 medium */
  defaultThinkingLevel: ThinkingLevel;

  // Skills / MCP servers（按引用登记，内容留在源应用目录）
  skills: SkillEntry[];
  /** 从 Claude Code 导入的插件；组件在 spawn 时由 Main 按 key 现读 */
  plugins: PluginEntry[];
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
  /** 虚拟模型：按请求路由到真实成员模型 */
  virtualModels: VirtualModelEntry[];
  /** 被关闭的内置子代理类型（name 集合） */
  disabledBuiltinAgentTypes: string[];
  /** 被关闭的内置工具（id 集合;默认全开） */
  disabledBuiltinTools: string[];
  /** 被关闭的内置工作流预设（id 集合;默认全开） */
  disabledWorkflowPresets: string[];
  /** 统一 subagent 工具允许创建的 Agent 模式。 */
  subagentAllowedModes: AgentMode[];

  /** 是否已完成首次运行引导；老用户（已有配置）视为已完成 */
  onboarded: boolean;

  /** 快捷键覆盖(action → 绑定串);只存与默认不同的项 */
  keybindings: Record<string, string>;

  // Projects（本地目录引用，作为会话工作目录）
  projects: Project[];
  /** 扁平项目组；缺省 []。项目用 groupId 挂靠 */
  projectGroups: ProjectGroup[];

  /** 用量估算覆盖：精确 model id → 四项单价 $/M；缺省 {} */
  usageModelPricing: PricingTable;

  // Setters
  setTheme: (theme: Theme) => void;
  setAccentColor: (accent: import('@shared/accentColor').AccentColor) => void;
  setLanguage: (language: Locale) => void;
  setTerminalTheme: (theme: string) => void;
  setTerminalFontSize: (size: number) => void;
  setTerminalFontFamily: (family: string) => void;
  setTerminalFontWeight: (weight: FontWeight) => void;
  setTerminalFontWeightBold: (weight: FontWeight) => void;
  setTerminalShell: (value: TerminalShell) => void;
  setWorktreeRoot: (path: string) => void;
  toggleFavoriteTerminalTheme: (theme: string) => void;
  setLoadLocalSkills: (value: boolean) => void;
  setLoadHarnessAssets: (value: boolean) => void;
  setWindowsLocalShell: (value: WindowsLocalShell) => void;
  setExploreFoldEnabled: (value: boolean) => void;
  setRtkEnabled: (value: boolean) => void;
  setProtectedActionsInCode: (value: boolean) => void;
  setMemoryEmbeddingModel: (value: string) => void;
  setMemoryEmbeddingAutoDownload: (value: boolean) => void;
  setMemoryModelIdleMinutes: (value: number) => void;
  setMemoryEmbeddingRemoteProviderId: (value: string | null) => void;
  setMemoryDistillEnabled: (value: boolean) => void;
  setMemoryKgEnabled: (value: boolean) => void;
  setVoiceInputEnabled: (value: boolean) => void;
  setBotModeEnabled: (value: boolean) => void;
  setBotRouteClassifier: (value: VirtualClassifierConfig | null) => void;
  setBotAssistantModel: (value: DefaultModelRef | null) => void;
  setVoiceInputDevice: (deviceId: string) => void;
  setVoiceModel: (model: SpeechModelId) => void;
  setVoiceCorrectionEnabled: (value: boolean) => void;
  setVoiceCorrectionModel: (model: string) => void;
  setVoiceCorrectionRemoteModel: (model: DefaultModelRef | null) => void;
  setVoiceVocabulary: (value: string) => void;
  setVoiceGeminiApiKey: (value: string) => void;
  setEditMode: (value: EditMode) => void;
  setCompactStrategy: (value: CompactStrategy) => void;
  setSmartCompactEnabled: (value: boolean) => void;
  setSmartCompactModel: (value: DefaultModelRef | null) => void;
  setSmartCompactMode: (value: import('@shared/smartCompactMode').SmartCompactMode) => void;
  setAutoUpdate: (value: boolean) => void;
  setAutoRestartWhenIdle: (value: boolean) => void;
  setProxyMode: (mode: ProxyMode) => void;
  setCustomProxyUrl: (url: string) => void;
  setOpenChangesOnFileEdit: (value: boolean) => void;
  setCompactReadOnlyTools: (value: boolean) => void;
  setExpandLiveEdits: (value: boolean) => void;
  setExpandLiveReasoning: (value: boolean) => void;
  setAutoCollapseTurns: (value: boolean) => void;
  setCollapseCompletedActivity: (value: boolean) => void;
  setPinUnfinishedTodos: (value: boolean) => void;
  setChatWide: (value: boolean) => void;
  setNotifyMainAgentOnly: (value: boolean) => void;
  setMaxActiveCoworkers: (value: number) => void;
  setSshTimeoutSeconds: (value: number) => void;
  setGenerationStallTimeoutMin: (minutes: number) => void;
  setAutoArchiveIdleDays: (days: number) => void;
  setAutoArchiveMergedWorktrees: (value: boolean) => void;
  setAutoDeleteArchivedDays: (days: number) => void;

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
  /** 按端点指纹去重（Custom 单独计）；撞车合并模型。返回新增或合并成功的条数 */
  addProviders: (providers: ModelProvider[]) => number;
  updateProvider: (id: string, updates: Partial<Omit<ModelProvider, 'id'>>) => void;
  removeProvider: (id: string) => void;

  /** 设置全局默认；只持久化 provider entry id + model id */
  setDefaultModel: (defaultModel: DefaultModelRef | null) => void;
  /** 打开后，聊天里换模型会写回全局默认；在设置里再选具体模型则钉死 */
  setDefaultModelFollowLast: (value: boolean) => void;
  /** 仅 follow-last 开启时写回默认模型，不把模式切回钉死 */
  rememberDefaultModelFromSelection: (selection: DefaultModelRef) => void;
  /** 用当前 OAuth 真凭证快照重校验；非 ready/stale 时绝不写回 */
  revalidateDefaultModel: (snapshot: OauthCredentialSnapshot) => DefaultModelRevalidation;
  setDefaultReasoningEnabled: (value: boolean) => void;
  setDefaultThinkingLevel: (level: ThinkingLevel) => void;
  // Title summary actions
  setTitleSummaryEnabled: (value: boolean) => void;
  /** 设置标题总结独立模型；null = 回到跟随全局默认 */
  setTitleSummaryModel: (model: DefaultModelRef | null) => void;
  /** 记忆提炼独立模型；null = 回落到标题模型 → 全局默认 */
  setMemoryDistillModel: (model: DefaultModelRef | null) => void;
  setMemoryChatModel: (modelId: string) => void;
  setMemoryLanguage: (language: string) => void;
  setApprovalReviewer: (model: DefaultModelRef | null) => void;
  setLastApprovalMode: (mode: ApprovalMode) => void;
  // Skill actions
  /** 按技能目录路径去重，返回实际新增数量 */
  addSkills: (skills: SkillEntry[]) => number;
  updateSkill: (id: string, updates: Partial<Omit<SkillEntry, 'id'>>) => void;
  /** 一次写入筛选结果的 enabled，避免逐条 persist */
  setSkillsEnabled: (ids: string[], enabled: boolean) => void;
  removeSkill: (id: string) => void;
  addPlugins: (plugins: PluginEntry[]) => number;
  setPluginEnabled: (id: string, enabled: boolean) => void;
  removePlugin: (id: string) => void;

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
  addVirtualModel: (entry: Omit<VirtualModelEntry, 'id'>) => VirtualModelEntry;
  updateVirtualModel: (id: string, updates: Partial<Omit<VirtualModelEntry, 'id'>>) => void;
  removeVirtualModel: (id: string) => void;

  // Agent type actions
  addAgentType: (entry: Omit<AgentTypeEntry, 'id'>) => AgentTypeEntry;
  updateAgentType: (id: string, updates: Partial<Omit<AgentTypeEntry, 'id'>>) => void;
  removeAgentType: (id: string) => void;
  toggleBuiltinAgentType: (name: string, enabled: boolean) => void;
  toggleBuiltinTool: (id: string, enabled: boolean) => void;
  toggleWorkflowPreset: (id: string, enabled: boolean) => void;
  setSubagentAllowedModes: (modes: AgentMode[]) => void;

  // Onboarding
  setOnboarded: (value: boolean) => void;

  // Keybinding actions
  setKeybinding: (action: string, binding: string) => void;
  resetKeybinding: (action: string) => void;

  // Project actions
  /** Main authority创建project并返回canonical projection。 */
  /** remote 传入时创建 ssh 远程项目;创建被拒(含远端探测失败)时抛 Error(message 可直接展示) */
  addProject: (
    path: string,
    remote?: { sshConnectionId: string },
    groupId?: string
  ) => Promise<Project | null>;
  removeProject: (id: string) => Promise<boolean>;
  createProjectGroup: (input: {
    name: string;
    emoji?: string;
    color?: string;
    defaultModel?: DefaultModelRef | null;
    defaultReasoningEnabled?: boolean | null;
    defaultThinkingLevel?: ThinkingLevel | null;
  }) => ProjectGroup;
  updateProjectGroup: (
    id: string,
    patch: {
      name?: string;
      emoji?: string;
      color?: string;
      defaultModel?: DefaultModelRef | null;
      defaultReasoningEnabled?: boolean | null;
      defaultThinkingLevel?: ThinkingLevel | null;
    }
  ) => void;
  removeProjectGroup: (id: string) => void;
  reorderProjectGroups: (activeId: string, overId: string) => void;
  setProjectGroupId: (projectId: string, groupId: string | null) => void;
  /** 空串或纯空白视为清除别名 */
  setProjectAlias: (projectId: string, alias: string | null) => void;
  setProjectDefaultModel: (
    projectId: string,
    model: DefaultModelRef | null,
    reasoning?: { reasoningEnabled: boolean; thinkingLevel: ThinkingLevel } | null
  ) => void;
  /** null = 跟随全局；数组覆盖全局（空 = 本项目全开） */
  setProjectDisabledBuiltinTools: (projectId: string, disabled: string[] | null) => void;
  /** null = 跟随全局；数组是项目级显式权限掩码。 */
  setProjectSubagentAllowedModes: (projectId: string, modes: AgentMode[] | null) => void;
  /** 记下用户确认过的项目代码来源；null = 撤销信任 */
  setProjectTrustedCode: (projectId: string, sources: string[] | null) => void;

  /** 非法条目不写入，返回 false */
  setUsageModelPricing: (modelId: string, pricing: ModelPricing) => boolean;
  removeUsageModelPricing: (modelId: string) => void;
}
