/** Main ↔ 插件进程的帧协议；一帧一条 JSON 消息 */

import type { PluginEventName } from './events';

/** 注入消息与工具进度的字符上限；gate、Main、worker 共用 */
export const PLUGIN_INJECT_MAX_CHARS = 32 * 1024;
/** 宿主包上不可信包裹（含转义）后送进 worker 的上限：正文上限再留出余量 */
export const PLUGIN_INJECT_WIRE_MAX_CHARS = PLUGIN_INJECT_MAX_CHARS + 4 * 1024;
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

/** 插件投递里的外部发送者。只保留这四个字段，插件自报的 owner / role 一律丢掉 */
export interface PluginInjectSender {
  channel: string;
  chatId?: string;
  userId?: string;
  displayName?: string;
}

export type PluginInjectOrigin = 'owner' | 'external';

const SENDER_CHANNEL = /^[a-zA-Z0-9._:-]{1,64}$/;

function isSenderRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 缺省表示没填；空串、超长和非安全数字都是非法 */
function parseSenderId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return null;
    return String(value);
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 128) return null;
  return trimmed;
}

/**
 * 边界解析插件自报的发送者。undefined 是没传；null 是传了但不合法。
 * 只抄 channel / chatId / userId / displayName。
 */
export function parsePluginInjectSender(value: unknown): PluginInjectSender | null | undefined {
  if (value === undefined) return undefined;
  if (!isSenderRecord(value)) return null;
  if (typeof value.channel !== 'string' || !SENDER_CHANNEL.test(value.channel.trim())) return null;
  const userId = parseSenderId(value.userId);
  if (userId === null) return null;
  const chatId = parseSenderId(value.chatId);
  if (chatId === null) return null;
  if (value.displayName !== undefined && typeof value.displayName !== 'string') return null;
  const displayName =
    typeof value.displayName === 'string' ? value.displayName.trim().slice(0, 128) : '';
  return {
    channel: value.channel.trim(),
    ...(userId ? { userId } : {}),
    ...(chatId ? { chatId } : {}),
    ...(displayName ? { displayName } : {}),
  };
}

export function parsePluginInjectOrigin(value: unknown): PluginInjectOrigin | undefined {
  return value === 'owner' || value === 'external' ? value : undefined;
}
/** 插件注入消息在会话里的 customType */
export const PLUGIN_MESSAGE_TYPE = 'enso-plugin-message';

/** 插件发起的只读代理：输入上限与超时 */
export const PLUGIN_AGENT_PROMPT_MAX_CHARS = 64 * 1024;
export const PLUGIN_AGENT_SYSTEM_MAX_CHARS = 32 * 1024;
export const PLUGIN_AGENT_DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const PLUGIN_AGENT_MAX_TIMEOUT_MS = 20 * 60_000;
export const PLUGIN_AGENT_TEXT_MAX_CHARS = 64 * 1024;
export const PLUGIN_AGENT_ARGS_MAX_CHARS = 4096;
export const PLUGIN_AGENT_OUTPUT_MAX_CHARS = 4096;
export const PLUGIN_AGENT_RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** 插件代理的进度与终态：worker → Main → 插件进程原样转发 */
export type PluginAgentRunEvent =
  /** parentId：codemode 等工具内部发起的嵌套调用 */
  | { type: 'tool-start'; id: string; name: string; args: string; parentId?: string }
  /** output：结果文本，截到 4K 字符 */
  | { type: 'tool-end'; id: string; isError: boolean; output?: string }
  /** 当前这条回复的完整正文（不是增量） */
  | { type: 'text'; text: string }
  /** model：实际使用的模型 id */
  | { type: 'end'; ok: true; text: string; model?: string }
  | { type: 'end'; ok: false; error: string; aborted?: boolean };

export function parsePluginAgentRunEvent(raw: unknown): PluginAgentRunEvent | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const keys = Object.keys(v);
  const only = (...allowed: string[]) => keys.every((key) => allowed.includes(key));
  const short = (s: unknown, max: number): s is string => typeof s === 'string' && s.length <= max;
  const id = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 256;
  switch (v.type) {
    case 'tool-start':
      return only('type', 'id', 'name', 'args', 'parentId') &&
        id(v.id) &&
        id(v.name) &&
        short(v.args, PLUGIN_AGENT_ARGS_MAX_CHARS) &&
        (v.parentId === undefined || id(v.parentId))
        ? {
            type: 'tool-start',
            id: v.id,
            name: v.name,
            args: v.args,
            ...(v.parentId ? { parentId: v.parentId } : {}),
          }
        : null;
    case 'tool-end':
      return only('type', 'id', 'isError', 'output') &&
        id(v.id) &&
        typeof v.isError === 'boolean' &&
        (v.output === undefined || short(v.output, PLUGIN_AGENT_OUTPUT_MAX_CHARS))
        ? {
            type: 'tool-end',
            id: v.id,
            isError: v.isError,
            ...(v.output !== undefined ? { output: v.output } : {}),
          }
        : null;
    case 'text':
      return only('type', 'text') && short(v.text, PLUGIN_AGENT_TEXT_MAX_CHARS)
        ? { type: 'text', text: v.text }
        : null;
    case 'end':
      if (v.ok === true)
        return only('type', 'ok', 'text', 'model') &&
          short(v.text, PLUGIN_AGENT_TEXT_MAX_CHARS) &&
          (v.model === undefined || id(v.model))
          ? { type: 'end', ok: true, text: v.text, ...(v.model ? { model: v.model } : {}) }
          : null;
      return v.ok === false &&
        only('type', 'ok', 'error', 'aborted') &&
        typeof v.error === 'string' &&
        v.error.length > 0 &&
        v.error.length <= 4096 &&
        (v.aborted === undefined || v.aborted === true)
        ? { type: 'end', ok: false, error: v.error, ...(v.aborted ? { aborted: true } : {}) }
        : null;
    default:
      return null;
  }
}

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
  /** 秘书联系方式往插件渠道发东西；payload { channelId, ...PluginContactRequest } */
  'contact.call',
] as const;
export type PluginCallMethod = (typeof PLUGIN_CALL_METHODS)[number];

/** contact.call 的请求：媒体字节按 base64 过进程边界，插件宿主转成 Buffer 再交给渠道 */
export type PluginContactRequest =
  | { op: 'sendText'; peerId: string; text: string }
  | { op: 'typing'; peerId: string }
  | {
      op: 'sendImage' | 'sendFile';
      peerId: string;
      data: string;
      fileName: string;
      mimeType?: string;
      caption?: string;
    };

export const PLUGIN_HOST_APIS = [
  'fs.readText',
  'fs.writeText',
  'net.fetch',
  'ui.notify',
  /** 推一条事件到本插件已打开的侧栏页面；args { name, data } */
  'ui.viewEvent',
  /** 打开右侧栏并创建或定位到本插件的侧栏页面；args { viewId? } */
  'ui.viewOpen',
  'ui.viewClose',
  /** 改清单声明过的输入框底栏状态项；args { id, text?, tooltip?, tone?, visible? } */
  'ui.statusUpdate',
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
  /** 向会话注入消息；args { sessionId?, text, images?, deliverAs?, triggerTurn?, trusted? } */
  'session.inject',
  /** 认领一个外部对象；args { key, sessionId?, label?, group?, subscribedAt?, candidates? } */
  'claims.claim',
  /** 续期自己持有的认领；args { key, sessionId? } */
  'claims.renew',
  /** 释放自己持有的认领；args { key, sessionId? } */
  'claims.release',
  /** 列出未过期认领；args { prefix?, sessionId?, pluginId? } */
  'claims.list',
  /** 登记一条需求线程；args { source, sessionId, subagentId?, secretaryId?, pr? } */
  'threads.open',
  /** 把 PR 绑到需求线程；args { threadId? , sessionId?, pr } */
  'threads.bindPr',
  /** 把 PR 事件只投给负责会话；args 即事件 */
  'threads.routePrEvent',
  /** 列出需求线程；args { status?, sessionId?, repo?, activeOnly? } */
  'threads.list',
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
  /** 秘书联系方式：注册渠道实现；args { channelId, caps } */
  'contact.register',
  /** 渠道收到一句话；args { channelId, peerId, text, senderId?, chatType?, chatTitle?, name?, at? } */
  'contact.inbound',
  /** 渠道状态；args { channelId, status, detail?, peers? } */
  'contact.setStatus',
  /** 列出会话及其状态；args { scope? }：缺省同项目，'all' 为所有项目（需 session.readAll）；返回 { current, sessions } */
  'session.list',
  /** 会话汇总状态；args { sessionId? } 缺省发起会话，返回 { sessionId, state, pendingAsks, pendingApprovals } */
  'session.status',
  /** 切换到会话；args { sessionId }，需用户手势 */
  'session.focus',
  /** 切到会话并展开某个子代理的详情；args { sessionId, agentId }，需用户手势 */
  'session.focusSubagent',
  /** 打开某个子会话的历史弹窗；args { parentId, childId }，需用户手势 */
  'session.openChildRun',
  /** 在发起会话的项目里新建会话并切过去；args { text?, presetId? }，presetId 只能填本插件的预设 */
  'session.create',
  /** 开关本进程的回合结束订阅；args { on }，权限同 session.status */
  'session.watchTurnEnd',
  /** 用发起会话的模型跑一个只读代理；args { runId, prompt, systemPrompt?, context?, timeoutMs? }，进度与结果经 agent-run 推送 */
  'agent.run',
  /** 取消本插件发起的代理；args { runId } */
  'agent.cancel',
] as const;
export type PluginHostApi = (typeof PLUGIN_HOST_APIS)[number];

export interface PluginErrorShape {
  code: string;
  message: string;
  /** 插件给用户看的提示（如「会话已过期，请在微信里给机器人发一条消息」）；旧插件没有 */
  userMessage?: string;
  /** 插件标记的预期业务错误（未登录、404、限流等）：照常回传，宿主只记 info、不进错误汇总 */
  expected?: true;
}

export type PluginLogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * 插件调用失败落日志的级别。取消与宿主主动停进程打断的调用是预期收尾，记 debug；
 * 插件给错误标了 `expected: true` 的是给用户看的业务错误，记 info；其余未知失败照旧记 error。
 */
export function pluginFailureLogLevel(
  error: unknown,
  context: { aborted?: boolean; stopped?: boolean } = {}
): Extract<PluginLogLevel, 'debug' | 'info' | 'error'> {
  const { code, expected } = (error ?? {}) as { code?: unknown; expected?: unknown };
  if (context.aborted || code === 'ABORTED') return 'debug';
  if (context.stopped && code === 'PLUGIN_EXITED') return 'debug';
  return expected === true ? 'info' : 'error';
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
  | {
      t: 'init';
      pluginId: string;
      pluginRoot: string;
      main: string;
      dataDir: string;
      /** 缺省关闭。只影响 console 采集，不影响宿主错误帧 */
      loggingEnabled?: boolean;
    }
  | { t: 'set-logging'; enabled: boolean }
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
  /** 订阅过的会话一轮结束（完成、失败或中止）；只发给调过 session.watchTurnEnd 的进程 */
  | { t: 'session-turn-end'; sessionId: string }
  /** agent.run 的进度与终态；end 之后不再有这个 runId 的消息 */
  | { t: 'agent-run'; runId: string; event: PluginAgentRunEvent }
  | PluginResponse;

export type PluginHostToMain =
  | { t: 'ready'; registered: PluginRegistrations }
  | { t: 'init-error'; message: string }
  | { t: 'call'; id: string; api: PluginHostApi; args: unknown; invocationId?: string }
  | { t: 'log'; level: PluginLogLevel; message: string }
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
