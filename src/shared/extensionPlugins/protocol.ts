/** Main ↔ 插件进程的帧协议；一帧一条 JSON 消息 */

import type { PluginEventName } from './events';

/** 注入消息与工具进度的字符上限；gate、Main、worker 共用 */
export const PLUGIN_INJECT_MAX_CHARS = 32 * 1024;
export const PLUGIN_PROGRESS_MAX_CHARS = 16 * 1024;
/** 注入消息可附带的图片：数量与单张 base64 长度上限 */
export const PLUGIN_INJECT_MAX_IMAGES = 4;
export const PLUGIN_INJECT_IMAGE_MAX_CHARS = 7 * 1024 * 1024;
const PLUGIN_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export interface PluginInjectImage {
  data: string;
  mimeType: string;
}

/** 合法则原样返回（去掉多余字段），否则 null；undefined 视为没有图片 */
export function parsePluginInjectImages(value: unknown): PluginInjectImage[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > PLUGIN_INJECT_MAX_IMAGES) return null;
  const images: PluginInjectImage[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const { data, mimeType } = item as Record<string, unknown>;
    if (typeof mimeType !== 'string' || !PLUGIN_IMAGE_MIME.has(mimeType)) return null;
    if (
      typeof data !== 'string' ||
      data.length === 0 ||
      data.length > PLUGIN_INJECT_IMAGE_MAX_CHARS ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
    )
      return null;
    images.push({ data, mimeType });
  }
  return images;
}
/** 插件注入消息在会话里的 customType */
export const PLUGIN_MESSAGE_TYPE = 'enso-plugin-message';

/** 注入消息的来源；界面据此标明是哪个插件发的 */
export interface PluginMessageSource {
  pluginId: string;
  pluginName: string;
}

const PLUGIN_ID = /^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/;

export function parsePluginMessageSource(raw: unknown): PluginMessageSource | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { pluginId, pluginName } = raw as Record<string, unknown>;
  if (typeof pluginId !== 'string' || pluginId.length > 40 || !PLUGIN_ID.test(pluginId))
    return null;
  if (typeof pluginName !== 'string' || pluginName.length === 0 || pluginName.length > 60)
    return null;
  return { pluginId, pluginName };
}

/**
 * 调用或事件来自子会话（subagent 派出的子代理、coworker）时的来源；主会话没有。
 * 插件侧是 `ctx.agent`，主会话与非会话调用为 null。
 */
export interface PluginAgentSource {
  kind: 'subagent' | 'coworker';
  /** 子会话 id，形如 `<主会话 id>::…`；`ctx.sessionId` 仍是所属主会话 */
  sessionId: string;
  /** 子代理实例名或 coworker 名 */
  name: string;
  /** agent 类型名；未指定类型的 coworker 没有 */
  agentType?: string;
}

/** 来源必须属于 `ownerSessionId` 这个子会话；主会话不能带来源 */
export function parsePluginAgentSource(
  raw: unknown,
  ownerSessionId: string
): PluginAgentSource | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['kind', 'sessionId', 'name', 'agentType'].includes(key)))
    return null;
  const { kind, sessionId, name, agentType } = value;
  if (kind !== 'subagent' && kind !== 'coworker') return null;
  if (sessionId !== ownerSessionId || !ownerSessionId.includes('::')) return null;
  if (typeof name !== 'string' || name.length === 0 || name.length > 128) return null;
  if (
    agentType !== undefined &&
    (typeof agentType !== 'string' || agentType.length === 0 || agentType.length > 128)
  )
    return null;
  return { kind, sessionId, name, ...(agentType !== undefined ? { agentType } : {}) };
}

export const PLUGIN_CALL_METHODS = [
  'tool.execute',
  'command.run',
  'trigger.candidates',
  'trigger.pick',
  'renderer.call',
  /** 会话事件；payload { event, data }，拦截型的返回值就是拦截结果 */
  'event.dispatch',
  /** 定时任务；payload { id } */
  'schedule.run',
  /** 其他插件调用本插件的导出方法；payload { name, args, caller } */
  'export.call',
] as const;
export type PluginCallMethod = (typeof PLUGIN_CALL_METHODS)[number];

export const PLUGIN_HOST_APIS = [
  'fs.readText',
  'fs.writeText',
  'net.fetch',
  'ui.notify',
  'composer.readDraft',
  'composer.insertText',
  'composer.replaceDraft',
  'config.get',
  'mcp.tools',
  'mcp.call',
  /** 工具执行中上报进度；args { text } */
  'tool.progress',
  /** 写一份产出文件；args { name, text | base64, mime? }，返回 { id, name, size, mime } */
  'artifact.write',
  /** 向会话注入消息；args { sessionId?, text, images?, deliverAs?, triggerTurn? } */
  'session.inject',
  /** 中止会话当前一轮；args { sessionId? }，权限同 session.inject */
  'session.abort',
  /** 调用其他插件导出的方法；args { pluginId, name, args } */
  'plugin.call',
  'ui.clipboard',
  'ui.openExternal',
  /** 运行期增减工具与命令；args { kind, name, ...meta } */
  'contrib.register',
  'contrib.unregister',
  /** 宿主能力探测 */
  'host.capabilities',
  /** 列出会话及其状态；args { scope? }：缺省同项目，'all' 为所有项目（需 session.readAll）；返回 { current, sessions } */
  'session.list',
  /** 会话汇总状态；args { sessionId? } 缺省发起会话，返回 { sessionId, state, pendingAsks, pendingApprovals } */
  'session.status',
  /** 切换到会话；args { sessionId }，需用户手势 */
  'session.focus',
  /** 在发起会话的项目里新建会话并切过去；args { text? } 预填输入框，需用户手势 */
  'session.create',
] as const;
export type PluginHostApi = (typeof PLUGIN_HOST_APIS)[number];

export interface PluginErrorShape {
  code: string;
  message: string;
}

export interface PluginRegistrations {
  tools: string[];
  commands: string[];
  triggers: string[];
  rendererMethods: string[];
  events: PluginEventName[];
  schedules: string[];
  exports: string[];
}

export type PluginResponse =
  | { t: 'res'; id: string; ok: true; value: unknown }
  | { t: 'res'; id: string; ok: false; error: PluginErrorShape };

export type MainToPluginHost =
  | { t: 'init'; pluginId: string; pluginRoot: string; main: string; dataDir: string }
  | {
      t: 'call';
      id: string;
      method: PluginCallMethod;
      payload: unknown;
      invocationId: string;
      sessionId: string | null;
      /** Main 推导的项目根；无本机项目为 null */
      projectRoot: string | null;
      /** 来自子会话时的来源；主会话不带 */
      agent?: PluginAgentSource;
    }
  | { t: 'cancel'; invocationId: string }
  /** 宿主正在收敛进程（停用、卸载、退出）；插件有短暂时间清理子进程 */
  | { t: 'shutdown' }
  | PluginResponse;

export type PluginHostToMain =
  | { t: 'ready'; registered: PluginRegistrations }
  | { t: 'init-error'; message: string }
  | { t: 'call'; id: string; api: PluginHostApi; args: unknown; invocationId?: string }
  | { t: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | PluginResponse;

/** 工具结果：插件可返回字符串或 { content, details } */
export interface PluginToolResult {
  content: string;
  details?: unknown;
  /** artifact.write 返回的产出 id；界面据此提供预览与另存 */
  artifacts?: string[];
}

/** 插件产出文件的公开描述；不含磁盘路径 */
export interface PluginArtifactInfo {
  id: string;
  pluginId: string;
  name: string;
  mime: string;
  size: number;
  createdAt: number;
}

/** 宿主能力；插件据此在桌面与服务端之间降级 */
export interface PluginHostCapabilities {
  host: 'desktop' | 'server';
  hostVersion: string;
  notify: boolean;
  mcp: boolean;
  clipboard: boolean;
  openExternal: boolean;
  composer: boolean;
}
