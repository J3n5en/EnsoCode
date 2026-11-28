/** 插件作者用的 enso API。从宿主实现再导出；引用本文件，不要复制。 */

import type * as React from 'react';
import type { PluginSlotName } from '../src/renderer/plugins/registry';
import type {
  AskRequestPayload,
  AskResolvedPayload,
  BeforeAgentStartPayload,
  ContextUsagePayload,
  InputPayload,
  ModelSelectPayload,
  PluginEventName,
  PluginSessionState,
  PluginSessionStatus,
  SessionStatusPayload,
  ToolCallPayload,
  ToolResultPayload,
} from '../src/shared/extensionPlugins/events';
import type {
  ExtensionPluginManifest,
  ExtensionPluginPermission,
} from '../src/shared/extensionPlugins/manifest';
import type {
  PluginAgentRunEvent,
  PluginAgentSource,
  PluginArtifactInfo,
  PluginHostCapabilities,
  PluginInjectImage,
  PluginToolResult,
} from '../src/shared/extensionPlugins/protocol';
import type { StatusPatch } from '../src/shared/extensionPlugins/statusItems';

export type {
  ExtensionPluginManifest,
  ExtensionPluginPermission,
  PluginAgentRunEvent,
  PluginAgentSource,
  PluginArtifactInfo,
  PluginEventName,
  PluginHostCapabilities,
  PluginInjectImage,
  PluginSlotName,
  PluginToolResult,
};

/** 作者编写的 enso-plugin.json。解析后的 `engines.enso` 会变成 `ExtensionPluginManifest.ensoRange`。 */
export type EnsoPluginManifest = Omit<
  ExtensionPluginManifest,
  | 'ensoRange'
  | 'description'
  | 'permissions'
  | 'fs'
  | 'net'
  | 'mcp'
  | 'resident'
  | 'env'
  | 'interop'
  | 'contributes'
> & {
  description?: string;
  engines?: { enso?: string };
  permissions?: ExtensionPluginPermission[];
  fs?: { read?: string[]; write?: string[] };
  net?: { domains?: string[] };
  mcp?: { tools?: string[] };
  resident?: boolean;
  env?: string[];
  interop?: { call?: string[] };
  contributes?: Omit<Partial<ExtensionPluginManifest['contributes']>, 'dynamic'> & {
    dynamic?: { tools?: number; commands?: number };
  };
};

export interface EnsoSessionInfo {
  id: string;
  title: string;
  updatedAt: number;
  /** 汇总状态：error > waiting（等你回答或审批）> running > idle */
  state: PluginSessionState;
  running?: boolean;
  archived?: boolean;
  /** 仅 `list({ scope: 'all' })` 带；projectName 为项目目录名 */
  projectId?: string;
  projectName?: string;
  /** 仅 `list({ scope: 'all', includeSecretary: true })` 列出的秘书会话带 `'secretary'`；其 projectName 为秘书名 */
  kind?: 'normal' | 'secretary';
}

export type EnsoSessionStatus = PluginSessionStatus;

export interface EnsoMcpTool {
  server: string;
  name: string;
  description: string;
}

export interface EnsoFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** base64：body 是请求体原始字节的 base64，用于上传二进制；解码后 ≤16MB */
  bodyEncoding?: 'text' | 'base64';
  responseType?: 'text' | 'base64';
}

export interface EnsoFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface EnsoDraft {
  text: string;
  hasReferences: boolean;
  generation: unknown;
  rev: unknown;
}

export interface EnsoDraftRev {
  rev: unknown;
}

export interface EnsoDraftExpect {
  generation: unknown;
  rev: unknown;
}

export type EnsoArtifactWrite =
  | { name: string; text: string; mime?: string }
  | { name: string; base64: string; mime?: string };

export interface EnsoInjectInput {
  text: string;
  images?: PluginInjectImage[];
  sessionId?: string;
  deliverAs?: 'nextTurn' | 'steer' | 'followUp';
  triggerTurn?: boolean;
  /** 同一外部对象只投给认领它的会话，例如 `github:acme/app#1:review` */
  claimKey?: string;
  claimLabel?: string;
  claimGroup?: string;
  /** 订阅时间，候选里越早越优先 */
  claimSubscribedAt?: number;
  claimCandidates?: EnsoClaimCandidate[];
}

/** 不带 claimKey 时注入仍返回 null，和旧插件兼容 */
export interface EnsoInjectResult {
  delivered: boolean;
  ownerSessionId: string;
  status: 'claimed' | 'renewed' | 'held-by-other';
}

export interface EnsoClaimCandidate {
  sessionId: string;
  subscribedAt?: number;
  active?: boolean;
}

export interface EnsoClaimView {
  key: string;
  sessionId: string;
  pluginId: string;
  label?: string;
  group?: string;
  subscribedAt?: number;
  claimedAt: number;
  lastHeartbeatAt: number;
  leaseUntil: number;
  active: boolean;
}

export interface EnsoClaimAcquireInput {
  key: string;
  sessionId?: string;
  label?: string;
  group?: string;
  subscribedAt?: number;
  candidates?: EnsoClaimCandidate[];
}

export type EnsoClaimAcquireResult =
  | {
      acquired: true;
      status: 'claimed' | 'renewed';
      ownerSessionId: string;
      claim: EnsoClaimView;
    }
  | {
      acquired: false;
      status: 'held-by-other';
      ownerSessionId: string;
      claim: EnsoClaimView;
    };

export type EnsoContribRegister =
  | {
      kind: 'tool';
      name: string;
      description: string;
      parameters: { type: 'object'; [key: string]: unknown };
      timeoutMs?: number;
    }
  | { kind: 'command'; name: string; title: string };

/** 秘书联系方式渠道的能力：核心按它降级（没按钮就编号文本，没编辑就不改旧消息） */
export interface EnsoContactCaps {
  buttons: boolean;
  urlButtons: boolean;
  edit: boolean;
  typing: boolean;
  format: 'html' | 'markdown' | 'plain';
  /** 单条上限，100–65536；超长由核心切条 */
  maxChars: number;
  commandMenu: boolean;
  /** 能发图片（需实现 sendImage）；缺省 false，核心改发一句带路径的文字 */
  images?: boolean;
  /** 能发文件（需实现 sendFile）；缺省 false */
  files?: boolean;
}

/** 秘书发出的一张图片或一个文件：单个 ≤10MB */
export interface EnsoContactMedia {
  /** 运行时是 Node 的 Buffer */
  data: Uint8Array;
  fileName: string;
  mimeType?: string;
  caption?: string;
}

/**
 * 渠道实现：peerId 一律字符串；sendImage / sendFile 只在 caps 声明后调用，抛错算发送失败。
 * 抛的错误可以带 `EnsoContactSendError` 的可选字段，宿主据此在渠道卡片上提示用户。
 */
export interface EnsoContactChannel {
  caps: EnsoContactCaps;
  sendText(peerId: string, message: { text: string }): Promise<{ messageId?: string } | undefined>;
  typing?(peerId: string, state: { on: boolean }): Promise<unknown>;
  sendImage?(peerId: string, media: EnsoContactMedia): Promise<{ messageId?: string } | undefined>;
  sendFile?(peerId: string, media: EnsoContactMedia): Promise<{ messageId?: string } | undefined>;
}

/** 发送失败时可以抛的错误：普通 Error 也行，多带的字段都可选 */
export interface EnsoContactSendError extends Error {
  /** 稳定的错误码，如 `SESSION_EXPIRED` */
  code?: string;
  /** 给用户看的下一步，原样显示在渠道卡片上 */
  userMessage?: string;
}

export interface EnsoContactInbound {
  peerId: string;
  /** 只发图片时可以是空串 */
  text: string;
  senderId?: string;
  chatType?: 'private' | 'group';
  chatTitle?: string;
  /** 显示名，进秘书会话头一行 */
  name?: string;
  /** 毫秒时间戳 */
  at?: number;
  /**
   * 随消息来的图片，最多 4 项：`data` 是 base64，宿主按文件头判格式（png/jpeg/webp/gif）、单张 ≤10MB 落盘；
   * 没下载的附件写 `rejected`，宿主统一回对方一句收不下。
   */
  images?: ({ data: string } | { rejected: 'too-large' | 'not-image' })[];
}

export interface EnsoContactStatus {
  status: 'unconfigured' | 'pending' | 'connected' | 'error';
  detail?: string;
  /** 主动推送发给谁：只报扫码/绑定的那个人 */
  peers?: string[];
}

export interface EnsoDemandThreadSource {
  channel: string;
  chatId: string;
  messageId: string;
  topicId?: string;
  senderId?: string;
  senderName?: string;
  summary?: string;
}

export interface EnsoDemandThreadPr {
  repo: string;
  number: number;
  url?: string;
  title?: string;
  headSha?: string;
}

export interface EnsoDemandMilestoneRecord {
  kind: 'pr_opened' | 'ci_failed' | 'needs_human' | 'merged';
  dedupeKey?: string;
  sentAt: number;
  summary?: string;
  replyMessageId?: string;
}

export interface EnsoDemandThreadView {
  id: string;
  source: EnsoDemandThreadSource;
  requesterIsOwner: boolean;
  sessionId: string;
  pluginId?: string;
  subagentId?: string;
  secretaryId?: string;
  pr?: EnsoDemandThreadPr;
  status: 'open' | 'in_progress' | 'pr_opened' | 'ci_failed' | 'needs_human' | 'merged' | 'closed';
  milestonesSent: EnsoDemandMilestoneRecord[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface EnsoDemandThreadOpen {
  source: EnsoDemandThreadSource;
  sessionId: string;
  subagentId?: string;
  secretaryId?: string;
  pr?: EnsoDemandThreadPr;
}

export interface EnsoDemandThreadFilter {
  status?: EnsoDemandThreadView['status'];
  sessionId?: string;
  repo?: string;
  activeOnly?: boolean;
}

export interface EnsoDemandPrEventInput {
  repo: string;
  number: number;
  kind:
    | 'pr_opened'
    | 'comment'
    | 'review'
    | 'ci_failed'
    | 'ci_passed'
    | 'needs_human'
    | 'merged'
    | 'closed';
  text: string;
  url?: string;
  title?: string;
  headSha?: string;
  summary?: string;
  sender?: { channel: string; chatId?: string; userId?: string; displayName?: string };
}

export type EnsoDemandPrRouteResult =
  | { routed: false; reason: 'no-thread' }
  | {
      routed: true;
      threadId: string;
      sessionId: string;
      delivered: boolean;
      milestonePushed: boolean;
      milestoneKind?: 'pr_opened' | 'ci_failed' | 'needs_human' | 'merged';
      replyMessageId?: string;
      error?: string;
    };

/** 每个 `PluginHostApi` 在作者侧的对应函数。动态注册走 contrib.*，进度走 `ctx.progress`。 */
export interface EnsoHostApi {
  'fs.readText': (path: string) => Promise<string>;
  'fs.writeText': (path: string, text: string) => Promise<void>;
  'net.fetch': (url: string, init?: EnsoFetchInit) => Promise<EnsoFetchResponse>;
  'ui.notify': (title: string, body?: string) => Promise<void>;
  'ui.viewEvent': (name: string, data?: unknown, options?: { sessionId?: string }) => Promise<void>;
  'ui.viewOpen': (input?: string | { viewId?: string; sessionId?: string }) => Promise<void>;
  'ui.viewClose': (input?: string | { viewId?: string; sessionId?: string }) => Promise<void>;
  'ui.statusUpdate': (id: string, patch: StatusPatch) => Promise<void>;
  'composer.readDraft': () => Promise<EnsoDraft>;
  'composer.insertText': (input: { text: string }) => Promise<EnsoDraftRev>;
  'composer.replaceDraft': (input: {
    text: string;
    expect?: EnsoDraftExpect;
  }) => Promise<EnsoDraftRev>;
  'config.get': () => Promise<Record<string, string | number | boolean>>;
  /** 只能在用户手势触发的调用里用；键须在清单 `configuration` 里声明，null 清除；落盘同设置页 */
  'config.set': (patch: Record<string, string | number | boolean | null>) => Promise<{ ok: true }>;
  'mcp.tools': () => Promise<EnsoMcpTool[]>;
  'mcp.call': (
    server: string,
    tool: string,
    args?: Record<string, unknown>
  ) => Promise<{ content: string; isError: boolean }>;
  'tool.progress': (text: string) => Promise<unknown>;
  'artifact.write': (input: EnsoArtifactWrite) => Promise<PluginArtifactInfo>;
  'session.inject': (input: EnsoInjectInput) => Promise<EnsoInjectResult | null>;
  'claims.claim': (input: EnsoClaimAcquireInput) => Promise<EnsoClaimAcquireResult>;
  'claims.renew': (key: string, sessionId?: string) => Promise<EnsoClaimView | null>;
  'claims.release': (key: string, sessionId?: string) => Promise<boolean>;
  'claims.list': (filter?: {
    prefix?: string;
    sessionId?: string;
    pluginId?: string;
  }) => Promise<EnsoClaimView[]>;
  'threads.open': (input: EnsoDemandThreadOpen) => Promise<EnsoDemandThreadView>;
  'threads.bindPr': (
    target: { threadId?: string; sessionId?: string },
    pr: EnsoDemandThreadPr
  ) => Promise<EnsoDemandThreadView | null>;
  'threads.routePrEvent': (event: EnsoDemandPrEventInput) => Promise<EnsoDemandPrRouteResult>;
  'threads.list': (filter?: EnsoDemandThreadFilter) => Promise<EnsoDemandThreadView[]>;
  'session.abort': (sessionId?: string) => Promise<void>;
  /** 替用户回答提问，需 `agent.inject`，跨会话授权同 `session.inject`；与桌面端同路径，谁先答算谁的 */
  'session.answerAsk': (input: {
    sessionId?: string;
    requestId: string;
    answer: string;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  'plugin.call': (pluginId: string, name: string, args?: unknown) => Promise<unknown>;
  'ui.clipboard': (text: string) => Promise<void>;
  'ui.openExternal': (url: string) => Promise<void>;
  'contrib.register': (input: EnsoContribRegister) => Promise<void>;
  'contrib.unregister': (input: { kind: 'tool' | 'command'; name: string }) => Promise<void>;
  'host.capabilities': () => Promise<PluginHostCapabilities>;
  /** 需要 `secretary.contact`；channelId 是清单 contactChannels 里的 id */
  'contact.register': (channelId: string, channel: EnsoContactChannel) => Promise<EnsoDisposable>;
  'contact.inbound': (channelId: string, message: EnsoContactInbound) => Promise<void>;
  'contact.setStatus': (channelId: string, status: EnsoContactStatus) => Promise<void>;
  'session.list': {
    (options?: { scope?: 'project' }): Promise<{ current: string; sessions: EnsoSessionInfo[] }>;
    /**
     * 所有项目的会话，需 `session.readAll`；不在宿主发起的调用里时 current 为 null。
     * includeSecretary 为 true 时含在用秘书的会话（`kind: 'secretary'`），缺省不含。
     */
    (options: {
      scope: 'all';
      includeSecretary?: boolean;
    }): Promise<{ current: string | null; sessions: EnsoSessionInfo[] }>;
  };
  /** 缺省发起会话；别的会话须在可见列表里 */
  'session.status': (sessionId?: string) => Promise<EnsoSessionStatus>;
  /**
   * 需 `session.focus` 与用户手势。缺省只能跳到本项目的会话；
   * 同时有 `session.readAll` 时可跳到任意项目与秘书会话，不绑会话的全局面板里也能用。
   */
  'session.focus': (sessionId: string) => Promise<void>;
  /** 切到会话并展开某个子代理的详情；子代理不是标签页，靠 TaskBar 展开 */
  'session.focusSubagent': (sessionId: string, agentId: string) => Promise<void>;
  /** 打开某个子会话的历史弹窗；已结束的 coworker 只能这样看 */
  'session.openChildRun': (parentId: string, childId: string) => Promise<void>;
  'session.create': (input?: { text?: string }) => Promise<{ sessionId: string }>;
  /** 内部开关，作者用 `enso.session.onTurnEnd` */
  'session.watchTurnEnd': (input: { on: boolean }) => Promise<void>;
  /**
   * 用发起会话的模型跑一个临时只读代理（read/grep/find/ls，不能改文件、不弹审批），需要 `agent.run`。
   * 必须在带会话的宿主调用里发起；运行不随调用结束，可在方法返回后继续，每个插件最多同时 2 个。
   */
  /** model：实际使用的模型 id */
  'agent.run': (input: EnsoAgentRunInput) => Promise<{ text: string; model?: string }>;
  /** 内部接口，作者用 `signal` 取消 */
  'agent.cancel': (input: { runId: string }) => Promise<boolean>;
}

export interface EnsoAgentRunInput {
  /** 任务正文，不超过 64K 字符 */
  prompt: string;
  /** 角色说明，包成 `<role>` 放在任务前；不超过 32K 字符 */
  systemPrompt?: string;
  /**
   * `conversation` 附上发起会话最近 40 条对话文本；
   * `fork` 从发起会话分叉：带完整对话、同模型，复用会话的提示缓存（插件设置了模型、或会话还没发过请求时退回 `conversation`）；
   * 缺省 `none`
   */
  context?: 'conversation' | 'fork' | 'none';
  /** 10 秒到 20 分钟，缺省 10 分钟 */
  timeoutMs?: number;
  /** 工具开始/结束与回复正文（完整正文，节流约 300ms） */
  onEvent?: (event: Exclude<PluginAgentRunEvent, { type: 'end' }>) => unknown;
  /** 中止后 Promise 以 `ABORTED` 拒绝 */
  signal?: AbortSignal;
}

export interface EnsoCallContext {
  sessionId: string | null;
  projectRoot: string | null;
  agent: PluginAgentSource | null;
  invocationId: string;
  signal: AbortSignal;
  progress: EnsoHostApi['tool.progress'];
  /** 仅 `exports.handle` 的处理函数会带上调用方插件 id */
  caller?: string;
}

export interface EnsoEventData {
  session_start: { reason: string };
  session_end: { reason: string };
  agent_start: Record<string, never>;
  /** silent：秘书本轮调用了 silence_turn（静默回合），外部通道不必回传 */
  agent_end: { text: string; silent?: true };
  before_compact: { reason: string };
  after_compact: { reason: string };
  tool_call: ToolCallPayload;
  tool_result: ToolResultPayload;
  input: InputPayload;
  context_usage: ContextUsagePayload;
  session_status: SessionStatusPayload;
  model_select: ModelSelectPayload;
  /** 拦截时返回 `{ append }` 追加到本轮 system prompt；只在主会话触发 */
  before_agent_start: BeforeAgentStartPayload;
  /** Enso 派发：看得见的主会话向用户提问；relayed 表示已转给秘书 */
  ask_request: AskRequestPayload;
  /** Enso 派发：提问收尾；by 缺省表示取消 */
  ask_resolved: AskResolvedPayload;
}

export type EnsoToolResult = string | Pick<PluginToolResult, 'content' | 'details'>;

export type EnsoToolHandler = (
  args: Record<string, unknown>,
  ctx: EnsoCallContext
) => EnsoToolResult | Promise<EnsoToolResult>;

export interface EnsoToolMeta {
  description: string;
  parameters: { type: 'object'; [key: string]: unknown };
  timeoutMs?: number;
}

export interface EnsoCommandMeta {
  title: string;
}

export type EnsoDisposable = () => void;

/** `main.mjs` 的 `activate(enso)`。 */
export interface EnsoMain {
  pluginId: string;
  dataDir: string;
  tools: {
    register(
      name: string,
      handler: EnsoToolHandler,
      meta?: EnsoToolMeta
    ): EnsoDisposable | Promise<EnsoDisposable>;
  };
  commands: {
    register(
      id: string,
      handler: (ctx: EnsoCallContext) => unknown,
      meta?: EnsoCommandMeta
    ): EnsoDisposable | Promise<EnsoDisposable>;
  };
  triggers: {
    register(
      name: string,
      handlers: {
        candidates: (
          query: string,
          ctx: EnsoCallContext
        ) =>
          | Array<{ id: string; label: string; detail?: string }>
          | Promise<Array<{ id: string; label: string; detail?: string }>>;
        pick: (
          item: unknown,
          ctx: EnsoCallContext
        ) => string | { text: string } | null | Promise<string | { text: string } | null>;
      }
    ): EnsoDisposable;
  };
  renderer: {
    handle(
      method: string,
      handler: (args: unknown, ctx: EnsoCallContext) => unknown
    ): EnsoDisposable;
  };
  events: {
    on<E extends PluginEventName>(
      event: E,
      handler: (data: EnsoEventData[E], ctx: EnsoCallContext) => unknown
    ): EnsoDisposable;
  };
  schedules: {
    register(id: string, handler: (ctx: EnsoCallContext) => unknown): EnsoDisposable;
  };
  exports: {
    handle(name: string, handler: (args: unknown, ctx: EnsoCallContext) => unknown): EnsoDisposable;
  };
  plugins: { call: EnsoHostApi['plugin.call'] };
  artifacts: { write: EnsoHostApi['artifact.write'] };
  session: {
    inject: EnsoHostApi['session.inject'];
    abort: EnsoHostApi['session.abort'];
    answerAsk: EnsoHostApi['session.answerAsk'];
    list: EnsoHostApi['session.list'];
    status: EnsoHostApi['session.status'];
    focus: EnsoHostApi['session.focus'];
    create: EnsoHostApi['session.create'];
    /**
     * 可见会话的一轮结束（完成、失败或中止）时回调；需 `session.read`（或 `session.readAll`）。
     * 返回取消订阅函数；进程退出、插件停用或卸载后自动失效。
     */
    onTurnEnd(listener: (event: { sessionId: string }) => void): EnsoDisposable;
  };
  claims: {
    claim: EnsoHostApi['claims.claim'];
    renew: EnsoHostApi['claims.renew'];
    release: EnsoHostApi['claims.release'];
    list: EnsoHostApi['claims.list'];
  };
  threads: {
    open: EnsoHostApi['threads.open'];
    bindPr: EnsoHostApi['threads.bindPr'];
    routePrEvent: EnsoHostApi['threads.routePrEvent'];
    list: EnsoHostApi['threads.list'];
  };
  host: { capabilities: EnsoHostApi['host.capabilities'] };
  /** 秘书联系方式渠道：register 交出收发实现，inbound 把对方的话交给秘书，setStatus 报登录状态 */
  contact: {
    register: EnsoHostApi['contact.register'];
    inbound: EnsoHostApi['contact.inbound'];
    setStatus: EnsoHostApi['contact.setStatus'];
  };
  agent: { run: EnsoHostApi['agent.run'] };
  fs: { readText: EnsoHostApi['fs.readText']; writeText: EnsoHostApi['fs.writeText'] };
  net: { fetch: EnsoHostApi['net.fetch'] };
  ui: {
    notify: EnsoHostApi['ui.notify'];
    /** 推给本插件已打开的侧栏页面；页面用 `enso.on` 订阅。需要 `ui.view`，不需要用户手势 */
    view: {
      emit: EnsoHostApi['ui.viewEvent'];
      /** 只推给绑定到指定会话的侧栏页面（等价于 `emit(name, data, { sessionId })`）。需要 `ui.view` */
      emitToSession: (sessionId: string, name: string, data?: unknown) => Promise<void>;
      /** 打开右侧栏并创建或聚焦本插件的侧栏页面（缺省首个视图）。需要 `ui.view` */
      open: EnsoHostApi['ui.viewOpen'];
      /** 关掉本插件的侧栏页面；右侧栏是 `open` 为它打开的就一并收起。需要 `ui.view` */
      close: EnsoHostApi['ui.viewClose'];
    };
    clipboard: { writeText: EnsoHostApi['ui.clipboard'] };
    openExternal: EnsoHostApi['ui.openExternal'];
    /** 改清单 `statusItems` 声明过的输入框底栏状态项；不需要权限和调用上下文，每秒最多 20 次 */
    status: { update: EnsoHostApi['ui.statusUpdate'] };
  };
  composer: {
    readDraft: EnsoHostApi['composer.readDraft'];
    insertText: EnsoHostApi['composer.insertText'];
    replaceDraft: EnsoHostApi['composer.replaceDraft'];
  };
  config: { get: EnsoHostApi['config.get']; set: EnsoHostApi['config.set'] };
  mcp: { tools: EnsoHostApi['mcp.tools']; call: EnsoHostApi['mcp.call'] };
}

export type EnsoSlotRegistration =
  | {
      slot: Extract<PluginSlotName, 'message.action'>;
      position: 'left' | 'right';
      component: (props: {
        position: 'left' | 'right';
        text: string;
        messageIndex: number;
        sessionId: string | null;
      }) => unknown;
    }
  | {
      slot: Extract<PluginSlotName, 'tool.card'>;
      toolName: string;
      component: (props: { toolName: string; output: string | null; state: string }) => unknown;
    }
  | {
      slot: Extract<PluginSlotName, 'block'>;
      language: string;
      component: (props: { language: string; source: string }) => unknown;
    }
  | {
      slot: Extract<PluginSlotName, 'composer.left' | 'composer.right'>;
      component: (props: {
        position: 'left' | 'right';
        sessionId: string | null;
        draft: string;
        busy: boolean;
        pluginPresetId: string | null;
      }) => unknown;
    }
  | {
      slot: Extract<PluginSlotName, 'thinking.body'>;
      component: (props: { text: string; streaming: boolean; itemKey: string }) => unknown;
    }
  | {
      slot: Extract<PluginSlotName, 'message.leaf'>;
      component: (props: {
        source: string;
        final: boolean;
        messageIndex: number;
        sessionId: string | null;
        Markdown: (props: { text: string }) => unknown;
      }) => unknown;
    };

/** `ui.js` 的 `onLoad(enso)`。`composer` 只在申请了 `composer.draft` 时存在。 */
export interface EnsoUi {
  React: typeof React;
  slots: { register(registration: EnsoSlotRegistration): EnsoDisposable };
  dispatch(action: 'plugin.call', payload: { method: string; args?: unknown }): Promise<unknown>;
  composer?: {
    readDraft: EnsoHostApi['composer.readDraft'];
    insertText: EnsoHostApi['composer.insertText'];
    replaceDraft: EnsoHostApi['composer.replaceDraft'];
  };
}

/** 侧栏 iframe 里的 `window.enso`。`theme` 随宿主主题更新，`onTheme` 订阅变化并返回取消函数。 */
export interface EnsoView {
  readonly theme: 'light' | 'dark';
  onTheme(listener: (theme: 'light' | 'dark') => void): () => void;
  /**
   * 页面当前对应的会话。会话页面打开后不变；`scope: "global"` 的页面跨会话常驻，
   * 用户切会话时更新并回调 `onSession`。没有当前会话时为 null。
   */
  readonly session: null | { readonly sessionId: string; readonly projectId: string | null };
  onSession(
    listener: (session: null | { sessionId: string; projectId: string | null }) => void
  ): () => void;
  on(name: string, listener: (data: unknown) => void): () => void;
  call(method: string, args?: unknown): Promise<unknown>;
  readonly storage: {
    get(key: string): string | null;
    set(key: string, value: string): void;
    remove(key: string): void;
  };
  /** 文件查看器里是当前文件，侧栏页面里是 null */
  readonly file: null | {
    readonly rel: string;
    readonly text: string;
    onChange(listener: (file: { rel: string; text: string }) => void): () => void;
    update(text: string): void;
  };
}
