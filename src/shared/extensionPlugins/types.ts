import type { ExtensionPluginPermission, PluginTriggerSymbol } from './manifest';

/** 设置页、安装确认页看到的插件摘要；不含任何磁盘路径 */
export interface ExtensionPluginSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  state: 'disabled' | 'enabled' | 'crashed';
  permissions: ExtensionPluginPermission[];
  tools: { name: string; description: string }[];
  commands: { id: string; title: string }[];
  /** entry 是安装目录内的相对路径，渲染层经 asset 通道取内容 */
  views: { id: string; title: string; entry: string }[];
  triggers: { symbol: PluginTriggerSymbol; name: string }[];
  hasRenderer: boolean;
  /** 渲染模块相对路径；渲染层经 asset 通道取源码，不是磁盘路径 */
  renderer?: string;
  /** 清单声明了配置项 */
  configurable: boolean;
  /** 插件自带的预设；id 是会话里使用的 plugin:<插件 id>:<预设 id> */
  presets: { id: string; name: string; skills: number; mcpServers: number; instruction: boolean }[];
  pendingVersion?: string;
  pendingPermissions?: ExtensionPluginPermission[];
}

/** 设置界面看到的配置项：密钥只报告是否已设置，不回显 */
export interface ExtensionPluginConfigField {
  key: string;
  title: string;
  description: string;
  secret: boolean;
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
}
