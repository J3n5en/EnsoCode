import type { ExtensionPluginPermission, PluginConfigType, PluginTriggerSymbol } from './manifest';

/** 设置页、安装确认页看到的插件摘要；不含任何磁盘路径 */
export interface ExtensionPluginSummary {
  id: string;
  name: string;
  version: string;
  /** 安装代号：每次安装、重装、restage 都会变，界面据此判断要不要重载 ui.js */
  build: string;
  description: string;
  /** 图片相对路径，渲染层经 asset 通道取 */
  icon?: string;
  state: 'disabled' | 'enabled' | 'crashed';
  permissions: ExtensionPluginPermission[];
  tools: { name: string; description: string }[];
  commands: { id: string; title: string }[];
  /** entry 是安装目录内的相对路径，渲染层经 asset 通道取内容 */
  views: { id: string; title: string; entry: string }[];
  /** path / css 是安装目录内的相对路径，渲染层经 asset 通道取；没同意样式能力时不带 css */
  themes: { id: string; name: string; path: string; css?: string }[];
  triggers: { symbol: PluginTriggerSymbol; name: string }[];
  hasRenderer: boolean;
  /** 渲染模块相对路径；渲染层经 asset 通道取源码，不是磁盘路径 */
  renderer?: string;
  /** 清单声明了配置项 */
  configurable: boolean;
  /** 插件自带的预设；id 是会话里使用的 plugin:<插件 id>:<预设 id> */
  presets: {
    id: string;
    name: string;
    skills: number;
    mcpServers: number;
    instruction: boolean;
    /** 预设指定的模型；界面选中预设时优先使用 */
    model?: { providerId: string; modelId: string };
  }[];
  /** 运行期注册的命令（不在清单里） */
  dynamicCommands?: { id: string; title: string }[];
  resident?: boolean;
  /** 常驻进程当前是否在跑 */
  running?: boolean;
  schedules?: { id: string; intervalSeconds: number; lastRunAt?: number; lastError?: string }[];
  events?: { event: string; mode: 'observe' | 'intercept' }[];
  /** 连续失败而临时放行的拦截事件；until 为恢复试探的时间 */
  interceptBreakers?: { event: string; until: number }[];
  /** 申请了 agent.inject 时：用户是否允许向非发起会话注入 */
  crossSessionInject?: boolean;
  pendingVersion?: string;
  pendingPermissions?: ExtensionPluginPermission[];
  /** 最近一次错误：崩溃停用的原因，或本次运行里最近的错误日志 */
  lastError?: { at: number; message: string };
  /** 安装来源；有就能「从来源重新安装」。本地路径不下发 */
  source?: { kind: 'dir' | 'zip' | 'market' } | { kind: 'url'; url: string };
  /** 检查更新发现的新版本（GitHub 或插件市场来源） */
  availableVersion?: string;
  /** 最近一次检查更新失败的原因 */
  updateCheckError?: string;
}

/** 插件市场里的一项，带本机安装状态 */
export interface ExtensionPluginMarketEntry {
  id: string;
  name: string;
  description: string;
  tier: 'official' | 'community';
  tags: string[];
  homepage?: string;
  /** 已转成 Worker 代理地址 */
  icon?: string;
  latest: string;
  permissions: string[];
  installedVersion?: string;
  updateAvailable: boolean;
}

export type ExtensionPluginMarketList =
  | { ok: true; stale: boolean; chinaMirror: boolean; plugins: ExtensionPluginMarketEntry[] }
  | { ok: false; error: string; chinaMirror: boolean };

/** 设置界面看到的配置项：密钥只报告是否已设置，不回显 */
export interface ExtensionPluginConfigField {
  key: string;
  title: string;
  description: string;
  secret: boolean;
  type: PluginConfigType;
  default?: string | number | boolean;
  options?: string[];
  min?: number;
  max?: number;
  pathKind?: 'file' | 'directory';
  set: boolean;
  value?: string;
}

export interface ExtensionPluginInstallPreview {
  token: string;
  id: string;
  name: string;
  version: string;
  description: string;
  permissions: ExtensionPluginPermission[];
  fsRead: string[];
  fsWrite: string[];
  netDomains: string[];
  mcpServers: { name: string; command: string; args: string[]; envKeys: string[] }[];
  /** 允许调用的宿主 MCP 工具名 */
  mcpTools: string[];
  env: string[];
  interop: string[];
  resident: boolean;
  /** 有主题带 CSS，可以改变应用任意界面 */
  styles: boolean;
  events: { event: string; mode: 'observe' | 'intercept'; failClosed: boolean }[];
  schedules: { id: string; intervalSeconds: number }[];
  tools: { name: string; description: string }[];
  hasRenderer: boolean;
  warnings: string[];
  existingVersion?: string;
  /** 相对已同意的授权是否扩大；新安装恒为 true */
  expands: boolean;
}

/** 会话下发给 worker 的插件工具描述 */
export interface PluginToolDescriptor {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  pluginId: string;
  /** 清单声明的单次上限；worker 据此放宽本地超时 */
  timeoutMs?: number;
}

/** 会话下发给 worker 的插件事件订阅；事件本身只流向 Main，插件身份由 Main 保留 */
export interface PluginEventPlan {
  /** 至少一个插件订阅的通知型事件 */
  observe: string[];
  /** 拦截型事件；tools 为空表示全部工具 */
  intercept: { event: string; tools?: string[] }[];
  /** 允许向本会话注入消息 */
  inject: boolean;
}

/** 插件登记表问题的待确认提示；由 Main 落盘，用户确认或重装后消失 */
export interface RegistryNotice {
  /** 被丢弃、还没重新安装的插件 id */
  discarded: string[];
  /** 登记表曾经读不出；插件列表可能不全，原文在 registry.json.unreadable */
  unreadable?: true;
}
