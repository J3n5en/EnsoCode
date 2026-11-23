import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { PluginSessionState, PluginSessionStatus } from '@shared/extensionPlugins/events';
import {
  type ExtensionPluginManifest,
  type ExtensionPluginPermission,
  isPluginRelativePath,
  pluginDomainAllowed,
} from '@shared/extensionPlugins/manifest';
import { parsePluginPresetId } from '@shared/extensionPlugins/preset';
import {
  PLUGIN_AGENT_DEFAULT_TIMEOUT_MS,
  PLUGIN_AGENT_MAX_TIMEOUT_MS,
  PLUGIN_AGENT_PROMPT_MAX_CHARS,
  PLUGIN_AGENT_RUN_ID,
  PLUGIN_AGENT_SYSTEM_MAX_CHARS,
  PLUGIN_INJECT_MAX_CHARS,
  type PluginArtifactInfo,
  type PluginHostApi,
  type PluginHostCapabilities,
  type PluginInjectImage,
  type PluginInjectSender,
  parsePluginInjectImages,
  parsePluginInjectSender,
} from '@shared/extensionPlugins/protocol';
import { parseStatusPatch, type StatusPatch } from '@shared/extensionPlugins/statusItems';
import type { SpawnModelConfig } from '@shared/types/agent';
import {
  type DemandPrEventInput,
  type DemandPrRouteResult,
  type DemandThreadPr,
  type DemandThreadStatus,
  type DemandThreadView,
  parseDemandPr,
  parseDemandPrEvent,
  parseDemandSource,
  parseDemandStatus,
} from '@shared/types/demandThreads';
import {
  type EventClaimAcquireResult,
  type EventClaimCandidate,
  type EventClaimView,
  parseClaimCandidates,
  parseClaimGroup,
  parseClaimKey,
  parseClaimLabel,
  parseClaimSubscribedAt,
} from '@shared/types/eventClaims';
import { pluginError } from './process';

export const GESTURE_TTL_MS = 30_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FETCH_BYTES = 5 * 1024 * 1024;
/** 请求体上限：秘书发的媒体最大 10MB，加密补齐后略大 */
const MAX_FETCH_BODY_BYTES = 16 * 1024 * 1024;
const MAX_DRAFT_BYTES = 32 * 1024;
const MAX_REDIRECTS = 5;
const SENSITIVE_REQUEST_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'cookie2',
]);
const MAX_MCP_ARGS_BYTES = 64 * 1024;
const MAX_CALL_DEPTH = 3;
const MAX_CLIPBOARD_BYTES = 1024 * 1024;
const OPEN_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const INJECT_PER_WINDOW = 5;
const INJECT_WINDOW_MS = 10_000;
/** 联系方式渠道入站：一个插件 10 秒最多 20 条，挡住失控的轮询刷进秘书会话 */
const CONTACT_INBOUND_PER_WINDOW = 20;
const CONTACT_PEER_MAX = 256;
const CONTACT_NAME_MAX = 64;
const CONTACT_MAX_PEERS = 8;
const CONTACT_STATUSES = new Set(['unconfigured', 'pending', 'connected', 'error']);
const CONTACT_FORMATS = new Set(['html', 'markdown', 'plain']);
/** 入站附图：一条最多 4 张；单张 10MB 的 base64 再长就不解码，按超限回给对方 */
const CONTACT_INBOUND_MAX_IMAGES = 4;
const CONTACT_INBOUND_IMAGE_MAX_CHARS = Math.ceil((10 * 1024 * 1024) / 3) * 4;
const CONTACT_IMAGE_REJECTIONS = new Set(['too-large', 'not-image']);

export type PluginContactInboundImage = { data: Buffer } | { rejected: 'too-large' | 'not-image' };

/**
 * contact.inbound 的 images：`{ data: base64 }` 交给宿主判格式落盘；
 * 插件没下载的附件写 `{ rejected: 'too-large' | 'not-image' }`，宿主统一回对方一句。
 */
export function parseContactInboundImages(value: unknown): PluginContactInboundImage[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > CONTACT_INBOUND_MAX_IMAGES) return null;
  const images: PluginContactInboundImage[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const { data, rejected } = item as Record<string, unknown>;
    if (
      data === undefined &&
      typeof rejected === 'string' &&
      CONTACT_IMAGE_REJECTIONS.has(rejected)
    ) {
      images.push({ rejected: rejected as 'too-large' | 'not-image' });
      continue;
    }
    if (typeof data !== 'string' || !data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
    images.push(
      data.length > CONTACT_INBOUND_IMAGE_MAX_CHARS
        ? { rejected: 'too-large' }
        : { data: Buffer.from(data, 'base64') }
    );
  }
  return images;
}

/** 插件上报的渠道能力：每项必须给全，缺一项就不认；images / files 是后加的，缺省 false */
export interface PluginContactCaps {
  buttons: boolean;
  urlButtons: boolean;
  edit: boolean;
  typing: boolean;
  format: 'html' | 'markdown' | 'plain';
  maxChars: number;
  commandMenu: boolean;
  images: boolean;
  files: boolean;
}

export function parsePluginContactCaps(raw: unknown): PluginContactCaps | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const flags = ['buttons', 'urlButtons', 'edit', 'typing', 'commandMenu'] as const;
  if (flags.some((key) => typeof v[key] !== 'boolean')) return null;
  const media = ['images', 'files'] as const;
  if (media.some((key) => v[key] !== undefined && typeof v[key] !== 'boolean')) return null;
  if (typeof v.format !== 'string' || !CONTACT_FORMATS.has(v.format)) return null;
  if (
    !Number.isInteger(v.maxChars) ||
    (v.maxChars as number) < 100 ||
    (v.maxChars as number) > 65_536
  )
    return null;
  return {
    buttons: v.buttons as boolean,
    urlButtons: v.urlButtons as boolean,
    edit: v.edit as boolean,
    typing: v.typing as boolean,
    format: v.format as PluginContactCaps['format'],
    maxChars: v.maxChars as number,
    commandMenu: v.commandMenu as boolean,
    images: v.images === true,
    files: v.files === true,
  };
}
const VIEW_EVENT_PER_SECOND = 20;
const MAX_ANCHORS = 32;
const VIEW_EVENT_NAME = /^[a-z][a-z0-9._-]{0,63}$/;
const MAX_VIEW_EVENT_BYTES = 256 * 1024;
/** 会话被唤起后等它就绪：worker 冷启动要加载 runtime/skill/MCP，可能十几秒 */
const WAKE_READY_MS = 60_000;
const WAKE_POLL_MS = 250;

export type ComposerOp = 'readDraft' | 'insertText' | 'replaceDraft';
/** 需要窗口配合的会话操作：切换到会话、展开某个子代理、在发起会话的项目里新建会话、启动没在运行的会话 */
export type SessionUiOp =
  | 'focusSession'
  | 'focusSubagent'
  | 'openChildRun'
  | 'createSession'
  | 'ensureSession'
  | 'openPluginView'
  | 'closePluginView';

/** 插件看到的会话：只有标识与展示字段，不含路径 */
export interface PluginSessionInfo {
  id: string;
  title: string;
  updatedAt: number;
  state: PluginSessionState;
  running?: boolean;
  archived?: boolean;
  /** 仅跨项目列表（scope: 'all'）带项目标识；名称为项目目录名 */
  projectId?: string;
  projectName?: string;
}

/** 草稿请求的目标：会话 + 发起手势的窗口（webContents id），草稿只回写到发起窗口 */
export interface ComposerTarget {
  sessionId: string;
  origin: number | null;
}

/** 宿主 MCP 调用的会话上下文：Main 据此选用会话所属项目的 MCP 配置 */
export interface McpTarget {
  sessionId: string | null;
  projectRoot: string | null;
}

export interface McpToolInfo {
  server: string;
  name: string;
  description: string;
}

export interface GateDeps {
  /** 已启用插件的清单；未启用返回 null */
  manifest(pluginId: string): ExtensionPluginManifest | null;
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** 不支持系统通知时返回 false */
  notify(title: string, body: string): boolean;
  /** 发起会话已静音时，ui.notify 直接成功但不弹系统通知 */
  sessionMuted?(sessionId: string): boolean;
  composer(
    target: ComposerTarget,
    op: ComposerOp,
    payload: Record<string, unknown>
  ): Promise<unknown>;
  /** 插件自己的配置值（含密钥）；只交给插件进程，不进渲染层 */
  config(pluginId: string): Record<string, string | number | boolean>;
  mcpTools(target: McpTarget, signal: AbortSignal): Promise<McpToolInfo[]>;
  mcpCall(
    target: McpTarget,
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<{ content: string; isError: boolean }>;
  now(): number;
  progress?(invocationId: string, text: string): void;
  writeArtifact?(
    pluginId: string,
    input: Record<string, unknown>
  ): PluginArtifactInfo | Promise<PluginArtifactInfo>;
  /** 用户是否允许该插件向非发起会话注入 */
  crossSessionInject?(pluginId: string): boolean;
  onInjectDenied?(pluginId: string): void;
  inject?(
    pluginId: string,
    input: {
      sessionId: string;
      text: string;
      images: PluginInjectImage[];
      deliverAs: 'steer' | 'followUp' | 'nextTurn';
      triggerTurn: boolean;
      /** 插件请求免包裹；是否生效由服务按 agent.injectTrusted 判 */
      trusted: boolean;
      claimKey?: string;
      claimLabel?: string;
      claimGroup?: string;
      claimSubscribedAt?: number;
      claimCandidates?: EventClaimCandidate[];
      sender?: PluginInjectSender;
    }
  ): SessionAttempt;
  /** 让发起窗口启动没在运行的会话（有历史就恢复）；就绪与否由注入重试判断 */
  wakeSession?(sessionId: string, origin: number | null): Promise<void>;
  /** 在会话旁启动只读代理；进度与终态由服务推给插件进程 */
  agentRun?(pluginId: string, input: PluginAgentRunRequest): SessionAttempt;
  /** 按用户在插件设置里选的模型解析代理模型；model 缺省表示跟随发起会话 */
  agentModel?(
    pluginId: string
  ): Promise<{ ok: true; model?: SpawnModelConfig } | { ok: false; error: string }>;
  /** 取消本插件的代理；没有这个代理返回 false */
  agentCancel?(pluginId: string, runId: string): boolean;
  abort?(pluginId: string, sessionId: string): { ok: true } | { ok: false; error: string };
  claims?: {
    claim(input: {
      key: string;
      sessionId: string;
      pluginId: string;
      label?: string;
      group?: string;
      subscribedAt?: number;
      candidates?: EventClaimCandidate[];
    }): EventClaimAcquireResult;
    renew(key: string, sessionId: string): EventClaimView | null;
    release(key: string, sessionId: string): boolean;
    list(filter?: { prefix?: string; sessionId?: string; pluginId?: string }): EventClaimView[];
    releaseSession?(sessionId: string): number;
  };
  threads?: {
    open(input: {
      source: DemandThreadView['source'];
      sessionId: string;
      pluginId?: string;
      subagentId?: string;
      secretaryId?: string;
      pr?: DemandThreadPr;
    }): DemandThreadView;
    bindPr(
      target: { threadId?: string; sessionId?: string },
      pr: DemandThreadPr
    ): DemandThreadView | null;
    routePrEvent(pluginId: string, event: DemandPrEventInput): Promise<DemandPrRouteResult>;
    list(filter?: {
      status?: DemandThreadStatus;
      sessionId?: string;
      repo?: string;
      activeOnly?: boolean;
    }): DemandThreadView[];
    findById(id: string): DemandThreadView | null;
    findBySource(channel: string, chatId: string, messageId: string): DemandThreadView | null;
    findByPr(repo: string, number: number): DemandThreadView | null;
    findActiveBySession(sessionId: string): DemandThreadView[];
  };
  callPlugin?(
    callerId: string,
    targetId: string,
    name: string,
    args: unknown,
    depth: number,
    caller: { sessionId: string | null; projectRoot: string | null; signal?: AbortSignal }
  ): Promise<unknown>;
  clipboard?(text: string): void;
  openExternal?(url: string): Promise<void> | void;
  /** 把事件广播到该插件已打开的侧栏页面 */
  viewEvent?(pluginId: string, name: string, data: unknown): void;
  /** 改输入框底栏的状态项；id 已校验在清单里 */
  statusUpdate?(pluginId: string, id: string, patch: StatusPatch): void;
  registerContrib?(pluginId: string, input: Record<string, unknown>): void;
  unregisterContrib?(pluginId: string, input: Record<string, unknown>): void;
  capabilities?(): PluginHostCapabilities;
  /** 秘书联系方式；channelId 已拼成 `<pluginId>:<id>` 并校验在清单里 */
  contact?: {
    register(pluginId: string, channelId: string, caps: PluginContactCaps): void;
    inbound(
      pluginId: string,
      channelId: string,
      input: {
        peerId: string;
        text: string;
        senderId?: string;
        chatType?: 'private' | 'group';
        chatTitle?: string;
        name?: string;
        at?: number;
        images?: PluginContactInboundImage[];
      }
    ): void;
    setStatus(
      pluginId: string,
      channelId: string,
      input: {
        status: 'unconfigured' | 'pending' | 'connected' | 'error';
        detail?: string;
        peers?: string[];
      }
    ): void;
  };
  sessions?: {
    /** 与 sessionId 同项目的主会话；按最近活动排序 */
    list(sessionId: string): PluginSessionInfo[];
    /** 所有项目的主会话 */
    listAll?(): PluginSessionInfo[];
    status?(sessionId: string): PluginSessionStatus;
  };
  sessionUi?(
    target: ComposerTarget,
    op: SessionUiOp,
    payload: Record<string, unknown>
  ): Promise<unknown>;
}

export type SessionAttempt =
  | {
      ok: true;
      skipped?: true;
      ownerSessionId?: string;
      claimStatus?: 'claimed' | 'renewed';
    }
  | { ok: false; error: string; notRunning?: boolean };

export interface PluginAgentRunRequest {
  runId: string;
  sessionId: string;
  prompt: string;
  systemPrompt?: string;
  context: 'conversation' | 'fork' | 'none';
  timeoutMs: number;
  model?: SpawnModelConfig;
}

export interface InvocationInit {
  pluginId: string;
  sessionId: string | null;
  /** Main 推导的项目根；SSH / 无项目为 null */
  projectRoot: string | null;
  /** 由用户手势触发（命令、挂件、侧栏页面、补全选中） */
  gesture: boolean;
  /** 发起调用的窗口；只有界面调用才有 */
  origin?: number | null;
  /** 界面调用来自远端窗口：不能动宿主桌面 */
  remote?: boolean;
  /** 工具调用才能上报进度；导出调用带上嵌套深度 */
  kind?: 'tool' | 'ui' | 'event' | 'schedule' | 'export';
  depth?: number;
}

interface Invocation extends InvocationInit {
  createdAt: number;
  cancelled: boolean;
  controller: AbortController;
}

/** 调用上下文表：插件只能拿着 Main 发的 id 回来，会话与项目根都不由插件上报 */
export class InvocationTable {
  private readonly table = new Map<string, Invocation>();
  constructor(private readonly now: () => number) {}

  create(init: InvocationInit): string {
    const id = randomUUID();
    this.table.set(id, {
      ...init,
      createdAt: this.now(),
      cancelled: false,
      controller: new AbortController(),
    });
    return id;
  }
  get(id: string | undefined): Invocation | undefined {
    return id ? this.table.get(id) : undefined;
  }
  cancel(id: string): void {
    const entry = this.table.get(id);
    if (!entry) return;
    entry.cancelled = true;
    entry.controller.abort();
  }
  /** 手势调用结束后保留到令牌过期，供插件稍后写草稿；非手势调用结束即删 */
  finish(id: string): void {
    const entry = this.table.get(id);
    if (!entry) return;
    if (!entry.gesture) {
      this.table.delete(id);
      return;
    }
    for (const [key, value] of this.table)
      if (value.gesture && this.now() - value.createdAt > GESTURE_TTL_MS) this.table.delete(key);
  }
  cancelPlugin(pluginId: string): void {
    for (const entry of this.table.values())
      if (entry.pluginId === pluginId) {
        entry.cancelled = true;
        entry.controller.abort();
      }
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const within = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
const covered = (path: string, scopes: string[]) =>
  scopes.some((s) => s === '.' || path === s || path.startsWith(`${s}/`));
const utf8Bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const posixRel = (root: string, real: string) => relative(root, real).split(sep).join('/');
const isEnoent = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code: unknown }).code === 'ENOENT';

function dropSensitiveHeaders(headers: Record<string, string>): void {
  for (const key of Object.keys(headers)) {
    if (SENSITIVE_REQUEST_HEADERS.has(key.toLowerCase())) delete headers[key];
  }
}

function dropHeader(headers: Record<string, string>, name: string): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) delete headers[key];
  }
}

async function readLimitedBody(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_FETCH_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw pluginError('TOO_LARGE', '响应过大');
  }
  const body = response.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > MAX_FETCH_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw pluginError('TOO_LARGE', '响应过大');
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return Buffer.concat(chunks);
}

export class PluginHostGate {
  readonly invocations: InvocationTable;
  private readonly injects = new Map<string, number[]>();
  private readonly viewEvents = new Map<string, number[]>();
  /** 插件被调用或注入过的主会话（新的在后）；常驻进程没有发起会话，回合结束按它们判定同项目 */
  private readonly anchors = new Map<string, string[]>();

  constructor(private readonly deps: GateDeps) {
    this.invocations = new InvocationTable(deps.now);
  }

  noteSession(pluginId: string, sessionId: string): void {
    const root = sessionId.split('::')[0];
    const list = (this.anchors.get(pluginId) ?? []).filter((id) => id !== root);
    list.push(root);
    this.anchors.set(pluginId, list.slice(-MAX_ANCHORS));
  }

  forgetSession(sessionId: string): void {
    for (const [pluginId, list] of this.anchors) {
      const next = list.filter((id) => id !== sessionId);
      if (next.length > 0) this.anchors.set(pluginId, next);
      else this.anchors.delete(pluginId);
    }
  }

  forgetPlugin(pluginId: string): void {
    this.anchors.delete(pluginId);
  }

  /** 回合结束推送的可见性：readAll 看所有项目；session.read 只看与插件用过的会话同项目的 */
  canSeeSession(pluginId: string, sessionId: string): boolean {
    const manifest = this.deps.manifest(pluginId);
    const sessions = this.deps.sessions;
    if (!manifest || !sessions) return false;
    if (
      manifest.permissions.includes('session.readAll') &&
      (sessions.listAll?.() ?? []).some((s) => s.id === sessionId)
    )
      return true;
    if (!manifest.permissions.includes('session.read')) return false;
    return (this.anchors.get(pluginId) ?? []).some(
      (anchor) => anchor === sessionId || sessions.list(anchor).some((s) => s.id === sessionId)
    );
  }

  /** 每个插件 10 秒内最多注入 5 条，防止失控的常驻插件撑爆会话上下文 */
  private admitInject(pluginId: string): void {
    const now = this.deps.now();
    const recent = (this.injects.get(pluginId) ?? []).filter((t) => now - t < INJECT_WINDOW_MS);
    if (recent.length >= INJECT_PER_WINDOW) throw pluginError('RATE_LIMITED', '注入消息过于频繁');
    recent.push(now);
    this.injects.set(pluginId, recent);
  }

  private admitContact(pluginId: string): void {
    const now = this.deps.now();
    const key = `contact:${pluginId}`;
    const recent = (this.injects.get(key) ?? []).filter((t) => now - t < INJECT_WINDOW_MS);
    if (recent.length >= CONTACT_INBOUND_PER_WINDOW)
      throw pluginError('RATE_LIMITED', '联系方式入站过于频繁');
    recent.push(now);
    this.injects.set(key, recent);
  }

  /** 每个插件每秒最多 20 条，避免 agent 把侧栏刷爆 */
  private admitViewEvent(pluginId: string): void {
    const now = this.deps.now();
    const recent = (this.viewEvents.get(pluginId) ?? []).filter((t) => now - t < 1000);
    if (recent.length >= VIEW_EVENT_PER_SECOND)
      throw pluginError('RATE_LIMITED', '侧栏事件过于频繁');
    recent.push(now);
    this.viewEvents.set(pluginId, recent);
  }

  /**
   * 缺省发起会话；指向别的会话要用户授权跨会话。
   * 常驻进程不在调用里或调用已结束（inv 为 null），只能凭跨会话授权指明会话。
   */
  private targetSession(
    pluginId: string,
    a: Record<string, unknown>,
    inv: Invocation | null
  ): string {
    const sessionId = typeof a.sessionId === 'string' ? a.sessionId : (inv?.sessionId ?? null);
    if (!sessionId) throw pluginError('NO_SESSION', '调用不属于任何会话');
    if (sessionId !== inv?.sessionId && !this.deps.crossSessionInject?.(pluginId)) {
      this.deps.onInjectDenied?.(pluginId);
      throw pluginError('PERMISSION_DENIED', '未允许向其他会话发送消息');
    }
    return sessionId;
  }

  async handle(
    pluginId: string,
    api: PluginHostApi,
    args: unknown,
    invocationId: string | undefined
  ) {
    const manifest = this.deps.manifest(pluginId);
    if (!manifest) throw pluginError('PLUGIN_DISABLED', '插件未启用');
    const a = isRecord(args) ? args : {};
    const permit = (permission: ExtensionPluginPermission) => {
      if (!manifest.permissions.includes(permission))
        throw pluginError('PERMISSION_DENIED', `插件未获授权：${permission}`);
    };
    /** session.readAll 涵盖本项目的读取 */
    const permitRead = () => {
      if (!manifest.permissions.includes('session.readAll')) permit('session.read');
    };
    const invocation = () => {
      const inv = this.invocations.get(invocationId);
      if (!inv || inv.pluginId !== pluginId)
        throw pluginError('NO_INVOCATION', '此接口只能在宿主发起的调用内使用');
      if (inv.cancelled) throw pluginError('ABORTED', '调用已取消');
      return inv;
    };
    /** 调用已结束（id 不在表里）按无调用处理：插件本就能不带 id 来调，回退不多给任何权限 */
    const optionalInvocation = () => (this.invocations.get(invocationId) ? invocation() : null);
    const gestured = (what: string) => {
      const inv = invocation();
      if (!inv.gesture || this.deps.now() - inv.createdAt > GESTURE_TTL_MS)
        throw pluginError('GESTURE_REQUIRED', `只能在用户操作触发的调用里${what}`);
      return inv;
    };
    const sessionOf = (inv: Invocation) => {
      if (!inv.sessionId) throw pluginError('NO_SESSION', '调用不属于任何会话');
      return inv.sessionId;
    };
    const sessionUi = () => {
      const ui = this.deps.sessionUi;
      if (!ui) throw pluginError('UNSUPPORTED', '当前环境不能操作会话');
      return ui;
    };

    switch (api) {
      case 'fs.readText': {
        permit('fs.read');
        const target = await this.resolveProjectPath(invocation(), a.path, manifest.fs.read, false);
        const info = await stat(target);
        if (!info.isFile()) throw pluginError('INVALID_ARGS', '不是文件');
        if (info.size > MAX_FILE_BYTES) throw pluginError('TOO_LARGE', '文件过大');
        return readFile(target, 'utf8');
      }
      case 'fs.writeText': {
        permit('fs.write');
        if (typeof a.text !== 'string' || utf8Bytes(a.text) > MAX_FILE_BYTES)
          throw pluginError('INVALID_ARGS', 'text 不合法或过大');
        const inv = invocation();
        const target = await this.resolveProjectPath(inv, a.path, manifest.fs.write, true);
        if (inv.cancelled) throw pluginError('ABORTED', '调用已取消');
        await writeFile(target, a.text, 'utf8');
        return null;
      }
      case 'net.fetch':
        permit('net.fetch');
        return this.fetch(manifest, a, this.invocations.get(invocationId)?.controller.signal);
      case 'ui.notify': {
        permit('ui.notify');
        if (typeof a.title !== 'string' || a.title.length === 0 || a.title.length > 200)
          throw pluginError('INVALID_ARGS', 'title 不合法');
        const body = typeof a.body === 'string' ? a.body.slice(0, 1000) : '';
        const sessionId = this.invocations.get(invocationId)?.sessionId;
        if (sessionId && this.deps.sessionMuted?.(sessionId)) return null;
        if (!this.deps.notify(a.title, body))
          throw pluginError('UNSUPPORTED', '当前环境不支持系统通知');
        return null;
      }
      case 'ui.viewEvent': {
        permit('ui.view');
        if (typeof a.name !== 'string' || !VIEW_EVENT_NAME.test(a.name))
          throw pluginError('INVALID_ARGS', 'name 不合法');
        let encoded: string;
        try {
          encoded = JSON.stringify(a.data === undefined ? null : a.data);
        } catch {
          throw pluginError('INVALID_ARGS', 'data 不能序列化');
        }
        if (encoded === undefined || utf8Bytes(encoded) > MAX_VIEW_EVENT_BYTES)
          throw pluginError('TOO_LARGE', '侧栏事件超过 256KB');
        if (!this.deps.viewEvent) throw pluginError('UNSUPPORTED', '当前环境不能更新侧栏');
        this.admitViewEvent(pluginId);
        this.deps.viewEvent(pluginId, a.name, JSON.parse(encoded) as unknown);
        return null;
      }
      case 'ui.statusUpdate': {
        const { id, ...rest } = a;
        if (
          typeof id !== 'string' ||
          !manifest.contributes.statusItems.some((item) => item.id === id)
        )
          throw pluginError('INVALID_ARGS', 'id 未在清单 statusItems 中声明');
        const patch = parseStatusPatch(rest);
        if (!patch) throw pluginError('INVALID_ARGS', '状态项字段不合法');
        if (!this.deps.statusUpdate) throw pluginError('UNSUPPORTED', '当前环境不能更新状态项');
        this.admitViewEvent(pluginId);
        this.deps.statusUpdate(pluginId, id, patch);
        return null;
      }
      case 'ui.viewOpen':
      case 'ui.viewClose': {
        permit('ui.view');
        const inv = invocation();
        const current = sessionOf(inv);
        const views = manifest.contributes.views;
        const view =
          a.viewId === undefined
            ? views[0]
            : typeof a.viewId === 'string'
              ? views.find((v) => v.id === a.viewId)
              : undefined;
        if (!view) throw pluginError('INVALID_ARGS', 'viewId 不合法或未在清单 views 中声明');
        let targetSessionId = current.split('::')[0];
        if (a.sessionId !== undefined) {
          if (
            typeof a.sessionId !== 'string' ||
            a.sessionId.length === 0 ||
            a.sessionId.length > 256
          )
            throw pluginError('INVALID_ARGS', 'sessionId 不合法');
          const candidate = a.sessionId.split('::')[0];
          if (candidate !== targetSessionId) {
            const visible = this.deps.sessions?.list(current) ?? [];
            if (!visible.some((s) => s.id === candidate))
              throw pluginError('NOT_FOUND', '会话不存在或不在本项目');
            targetSessionId = candidate;
          }
        }
        const target = { sessionId: targetSessionId, origin: inv.origin ?? null };
        if (api === 'ui.viewOpen')
          await sessionUi()(target, 'openPluginView', {
            pluginId,
            viewId: view.id,
            title: view.title,
          });
        else await sessionUi()(target, 'closePluginView', { pluginId, viewId: view.id });
        return null;
      }
      case 'composer.readDraft':
      case 'composer.insertText':
      case 'composer.replaceDraft': {
        permit('composer.draft');
        const inv = invocation();
        if (!inv.gesture || this.deps.now() - inv.createdAt > GESTURE_TTL_MS)
          throw pluginError('GESTURE_REQUIRED', '只能在用户操作触发的调用里读写草稿');
        if (!inv.sessionId) throw pluginError('NO_SESSION', '调用不属于任何会话');
        const op = api.slice('composer.'.length) as ComposerOp;
        if (
          op !== 'readDraft' &&
          (typeof a.text !== 'string' || utf8Bytes(a.text) > MAX_DRAFT_BYTES)
        )
          throw pluginError('INVALID_ARGS', 'text 不合法或超过 32KB');
        return this.deps.composer({ sessionId: inv.sessionId, origin: inv.origin ?? null }, op, a);
      }
      case 'config.get':
        return this.deps.config(pluginId);
      case 'mcp.tools': {
        permit('mcp.call');
        const inv = invocation();
        const allowed = new Set(manifest.mcp.tools);
        const tools = await this.deps.mcpTools(
          {
            sessionId: inv.sessionId,
            projectRoot: inv.projectRoot,
          },
          inv.controller.signal
        );
        return tools.filter((t) => allowed.has(t.name));
      }
      case 'mcp.call': {
        permit('mcp.call');
        if (typeof a.tool !== 'string' || !manifest.mcp.tools.includes(a.tool))
          throw pluginError('PERMISSION_DENIED', `清单没有声明 MCP 工具：${String(a.tool)}`);
        const inv = invocation();
        if (typeof a.server !== 'string' || a.server.length === 0 || a.server.length > 128)
          throw pluginError('INVALID_ARGS', 'server 不合法');
        const args = a.args === undefined ? {} : a.args;
        if (!isRecord(args) || utf8Bytes(JSON.stringify(args)) > MAX_MCP_ARGS_BYTES)
          throw pluginError('INVALID_ARGS', 'args 必须是不超过 64KB 的对象');
        return this.deps.mcpCall(
          { sessionId: inv.sessionId, projectRoot: inv.projectRoot },
          a.server,
          a.tool,
          args,
          inv.controller.signal
        );
      }
      case 'tool.progress': {
        const inv = invocation();
        if (inv.kind !== 'tool') throw pluginError('NO_INVOCATION', '只能在工具调用里上报进度');
        if (typeof a.text !== 'string' || a.text.length === 0)
          throw pluginError('INVALID_ARGS', 'text 不合法');
        this.deps.progress?.(invocationId ?? '', a.text.slice(0, 16 * 1024));
        return null;
      }
      case 'artifact.write': {
        invocation();
        if (!this.deps.writeArtifact) throw pluginError('UNSUPPORTED', '当前环境不能写产出');
        return await this.deps.writeArtifact(pluginId, a);
      }
      case 'session.inject': {
        permit('agent.inject');
        const injectInv = optionalInvocation();
        const sessionId = this.targetSession(pluginId, a, injectInv);
        if (
          typeof a.text !== 'string' ||
          a.text.length === 0 ||
          a.text.length > PLUGIN_INJECT_MAX_CHARS
        )
          throw pluginError('INVALID_ARGS', 'text 不合法或超过 32K 字符');
        const images = parsePluginInjectImages(a.images);
        if (!images)
          throw pluginError('INVALID_ARGS', 'images 不合法：最多 4 张 png/jpeg/webp/gif 的 base64');
        // nextTurn 只排队不触发，和 triggerTurn 互相矛盾；要触发一轮就得走 followUp
        const deliverAs = a.deliverAs ?? (a.triggerTurn === true ? 'followUp' : 'nextTurn');
        if (deliverAs !== 'steer' && deliverAs !== 'followUp' && deliverAs !== 'nextTurn')
          throw pluginError('INVALID_ARGS', 'deliverAs 不合法');
        if (a.triggerTurn !== undefined && typeof a.triggerTurn !== 'boolean')
          throw pluginError('INVALID_ARGS', 'triggerTurn 不合法');
        if (a.trusted !== undefined && typeof a.trusted !== 'boolean')
          throw pluginError('INVALID_ARGS', 'trusted 不合法');
        const claim = this.readClaimRequest(a);
        const sender = parsePluginInjectSender(a.sender);
        if (sender === null) throw pluginError('INVALID_ARGS', 'sender 不合法');
        const bridge = this.deps.inject;
        if (!bridge) throw pluginError('UNSUPPORTED', '当前环境不能注入消息');
        this.admitInject(pluginId);
        const input: Parameters<typeof bridge>[1] = {
          sessionId,
          text: a.text,
          images,
          deliverAs,
          triggerTurn: a.triggerTurn === true,
          trusted: a.trusted === true,
          ...claim,
          ...(sender ? { sender } : {}),
        };
        const result = await this.untilRunning(
          () => bridge(pluginId, input),
          sessionId,
          injectInv?.origin ?? null,
          'INJECT_FAILED'
        );
        if (!result.ok) throw pluginError('INJECT_FAILED', result.error);
        this.noteSession(pluginId, sessionId);
        if (result.skipped) {
          return {
            delivered: false,
            ownerSessionId: result.ownerSessionId ?? sessionId,
            status: 'held-by-other',
          };
        }
        if (!claim.claimKey) return null;
        return {
          delivered: true,
          ownerSessionId: sessionId,
          status: result.claimStatus ?? 'claimed',
        };
      }
      case 'agent.run': {
        permit('agent.run');
        const inv = invocation();
        const sessionId = sessionOf(inv);
        if (typeof a.runId !== 'string' || !PLUGIN_AGENT_RUN_ID.test(a.runId))
          throw pluginError('INVALID_ARGS', 'runId 不合法');
        if (
          typeof a.prompt !== 'string' ||
          !a.prompt.trim() ||
          a.prompt.length > PLUGIN_AGENT_PROMPT_MAX_CHARS
        )
          throw pluginError('INVALID_ARGS', 'prompt 不合法或超过 64K 字符');
        if (
          a.systemPrompt !== undefined &&
          (typeof a.systemPrompt !== 'string' ||
            a.systemPrompt.length > PLUGIN_AGENT_SYSTEM_MAX_CHARS)
        )
          throw pluginError('INVALID_ARGS', 'systemPrompt 不合法或超过 32K 字符');
        const context = a.context ?? 'none';
        if (context !== 'conversation' && context !== 'fork' && context !== 'none')
          throw pluginError('INVALID_ARGS', 'context 只能是 conversation、fork 或 none');
        const timeoutMs = a.timeoutMs ?? PLUGIN_AGENT_DEFAULT_TIMEOUT_MS;
        if (
          typeof timeoutMs !== 'number' ||
          !Number.isInteger(timeoutMs) ||
          timeoutMs < 10_000 ||
          timeoutMs > PLUGIN_AGENT_MAX_TIMEOUT_MS
        )
          throw pluginError('INVALID_ARGS', 'timeoutMs 须是 10 秒到 20 分钟的整数毫秒');
        const run = this.deps.agentRun;
        if (!run) throw pluginError('UNSUPPORTED', '当前环境不能运行代理');
        const picked = (await this.deps.agentModel?.(pluginId)) ?? { ok: true };
        if (!picked.ok) throw pluginError('AGENT_FAILED', picked.error);
        const input: PluginAgentRunRequest = {
          runId: a.runId,
          sessionId,
          prompt: a.prompt,
          ...(a.systemPrompt ? { systemPrompt: a.systemPrompt } : {}),
          context,
          timeoutMs,
          ...(picked.model ? { model: picked.model } : {}),
        };
        const result = await this.untilRunning(
          () => run(pluginId, input),
          sessionId,
          inv.origin ?? null,
          'AGENT_FAILED'
        );
        if (!result.ok) throw pluginError('AGENT_FAILED', result.error);
        return null;
      }
      case 'agent.cancel':
        permit('agent.run');
        if (typeof a.runId !== 'string' || !PLUGIN_AGENT_RUN_ID.test(a.runId))
          throw pluginError('INVALID_ARGS', 'runId 不合法');
        return this.deps.agentCancel?.(pluginId, a.runId) ?? false;
      case 'session.abort': {
        permit('agent.inject');
        const sessionId = this.targetSession(pluginId, a, optionalInvocation());
        if (!this.deps.abort) throw pluginError('UNSUPPORTED', '当前环境不能中止会话');
        const result = this.deps.abort(pluginId, sessionId);
        if (!result.ok) throw pluginError('ABORT_FAILED', result.error);
        this.deps.claims?.releaseSession?.(sessionId);
        return null;
      }
      case 'claims.claim':
      case 'claims.renew':
      case 'claims.release':
      case 'claims.list':
        return this.claims(pluginId, api, a, optionalInvocation());
      case 'threads.open':
      case 'threads.bindPr':
      case 'threads.routePrEvent':
      case 'threads.list':
        return this.threadsApi(pluginId, api, a, optionalInvocation());
      case 'plugin.call': {
        permit('plugin.call');
        const inv = invocation();
        if ((inv.depth ?? 0) >= MAX_CALL_DEPTH) throw pluginError('CALL_DEPTH', '插件调用嵌套过深');
        if (typeof a.pluginId !== 'string' || typeof a.name !== 'string' || a.name.length === 0)
          throw pluginError('INVALID_ARGS', 'pluginId 或 name 不合法');
        if (!manifest.interop.call.includes(a.pluginId))
          throw pluginError('PERMISSION_DENIED', `清单没有允许调用 ${a.pluginId}`);
        const args = a.args === undefined ? {} : a.args;
        if (utf8Bytes(JSON.stringify(args ?? null)) > MAX_MCP_ARGS_BYTES)
          throw pluginError('INVALID_ARGS', 'args 超过 64KB');
        if (!this.deps.callPlugin) throw pluginError('UNSUPPORTED', '当前环境不能调用其他插件');
        return this.deps.callPlugin(pluginId, a.pluginId, a.name, args, (inv.depth ?? 0) + 1, {
          sessionId: inv.sessionId,
          projectRoot: inv.projectRoot,
          signal: inv.controller.signal,
        });
      }
      case 'ui.clipboard': {
        permit('ui.clipboard');
        const inv = invocation();
        if (!inv.gesture || this.deps.now() - inv.createdAt > GESTURE_TTL_MS)
          throw pluginError('GESTURE_REQUIRED', '只能在用户操作触发的调用里写剪贴板');
        if (typeof a.text !== 'string' || utf8Bytes(a.text) > MAX_CLIPBOARD_BYTES)
          throw pluginError('INVALID_ARGS', 'text 不合法或过大');
        if (!this.deps.clipboard || inv.remote)
          throw pluginError('UNSUPPORTED', '当前环境不能写剪贴板');
        this.deps.clipboard(a.text);
        return null;
      }
      case 'ui.openExternal': {
        permit('ui.openExternal');
        const inv = invocation();
        if (!inv.gesture || this.deps.now() - inv.createdAt > GESTURE_TTL_MS)
          throw pluginError('GESTURE_REQUIRED', '只能在用户操作触发的调用里打开链接');
        if (typeof a.url !== 'string') throw pluginError('INVALID_ARGS', 'url 不合法');
        let parsed: URL;
        try {
          parsed = new URL(a.url);
        } catch {
          throw pluginError('INVALID_ARGS', 'url 不合法');
        }
        if (!OPEN_PROTOCOLS.has(parsed.protocol))
          throw pluginError('INVALID_ARGS', '只接受 http、https 或 mailto');
        if (!this.deps.openExternal || inv.remote)
          throw pluginError('UNSUPPORTED', '当前环境不能打开链接');
        await this.deps.openExternal(parsed.href);
        return null;
      }
      case 'contrib.register':
        this.deps.registerContrib?.(pluginId, a);
        return null;
      case 'contrib.unregister':
        this.deps.unregisterContrib?.(pluginId, a);
        return null;
      case 'contact.register':
      case 'contact.inbound':
      case 'contact.setStatus': {
        permit('secretary.contact');
        const contact = this.deps.contact;
        if (!contact) throw pluginError('UNSUPPORTED', '当前环境没有秘书联系方式');
        const local = typeof a.channelId === 'string' ? a.channelId : '';
        if (!(manifest.contributes.contactChannels ?? []).some((item) => item.id === local))
          throw pluginError('INVALID_ARGS', `清单未声明联系方式渠道 ${local}`);
        const channelId = `${pluginId}:${local}`;
        if (api === 'contact.register') {
          const caps = parsePluginContactCaps(a.caps);
          if (!caps) throw pluginError('INVALID_ARGS', 'caps 不合法');
          contact.register(pluginId, channelId, caps);
          return null;
        }
        if (api === 'contact.inbound') {
          const peerId = a.peerId;
          if (typeof peerId !== 'string' || !peerId || peerId.length > CONTACT_PEER_MAX)
            throw pluginError('INVALID_ARGS', 'peerId 不合法');
          const images = parseContactInboundImages(a.images);
          if (!images)
            throw pluginError(
              'INVALID_ARGS',
              'images 不合法：最多 4 项，每项 { data: base64 } 或 { rejected: too-large | not-image }'
            );
          if (
            typeof a.text !== 'string' ||
            (!a.text.trim() && images.length === 0) ||
            a.text.length > PLUGIN_INJECT_MAX_CHARS
          )
            throw pluginError('INVALID_ARGS', 'text 不合法或过长');
          if (
            a.name !== undefined &&
            (typeof a.name !== 'string' || a.name.length > CONTACT_NAME_MAX)
          )
            throw pluginError('INVALID_ARGS', 'name 不合法');
          const senderId = a.senderId;
          if (
            senderId !== undefined &&
            (typeof senderId !== 'string' || !senderId || senderId.length > CONTACT_PEER_MAX)
          )
            throw pluginError('INVALID_ARGS', 'senderId 不合法');
          const chatType = a.chatType;
          if (chatType !== undefined && chatType !== 'private' && chatType !== 'group')
            throw pluginError('INVALID_ARGS', 'chatType 只能是 private 或 group');
          if (
            a.chatTitle !== undefined &&
            (typeof a.chatTitle !== 'string' || a.chatTitle.length > CONTACT_NAME_MAX)
          )
            throw pluginError('INVALID_ARGS', 'chatTitle 不合法');
          if (a.at !== undefined && (typeof a.at !== 'number' || !Number.isFinite(a.at)))
            throw pluginError('INVALID_ARGS', 'at 不合法');
          this.admitContact(pluginId);
          contact.inbound(pluginId, channelId, {
            peerId,
            text: a.text,
            ...(senderId ? { senderId } : {}),
            ...(chatType ? { chatType } : {}),
            ...(typeof a.chatTitle === 'string' && a.chatTitle ? { chatTitle: a.chatTitle } : {}),
            ...(typeof a.name === 'string' && a.name ? { name: a.name } : {}),
            ...(typeof a.at === 'number' ? { at: a.at } : {}),
            ...(images.length ? { images } : {}),
          });
          return null;
        }
        if (typeof a.status !== 'string' || !CONTACT_STATUSES.has(a.status))
          throw pluginError('INVALID_ARGS', 'status 不合法');
        const peers = a.peers;
        if (
          peers !== undefined &&
          (!Array.isArray(peers) ||
            peers.length > CONTACT_MAX_PEERS ||
            peers.some((p) => typeof p !== 'string' || !p || p.length > CONTACT_PEER_MAX))
        )
          throw pluginError('INVALID_ARGS', 'peers 不合法');
        contact.setStatus(pluginId, channelId, {
          status: a.status as 'unconfigured' | 'pending' | 'connected' | 'error',
          ...(typeof a.detail === 'string' && a.detail ? { detail: a.detail.slice(0, 200) } : {}),
          ...(peers ? { peers: peers as string[] } : {}),
        });
        return null;
      }
      case 'host.capabilities':
        return (
          this.deps.capabilities?.() ?? {
            host: 'desktop' as const,
            hostVersion: '',
            notify: false,
            mcp: false,
            clipboard: false,
            openExternal: false,
            composer: false,
          }
        );
      case 'session.list': {
        if (a.scope === 'all') {
          permit('session.readAll');
          if (!this.deps.sessions?.listAll)
            throw pluginError('UNSUPPORTED', '当前环境不能列出会话');
          return {
            current: optionalInvocation()?.sessionId ?? null,
            sessions: this.deps.sessions.listAll(),
          };
        }
        if (a.scope !== undefined && a.scope !== 'project')
          throw pluginError('INVALID_ARGS', 'scope 只能是 project 或 all');
        permitRead();
        const current = sessionOf(invocation());
        if (!this.deps.sessions) throw pluginError('UNSUPPORTED', '当前环境不能列出会话');
        return { current, sessions: this.deps.sessions.list(current) };
      }
      case 'session.status': {
        permitRead();
        const sessions = this.deps.sessions;
        if (!sessions?.status) throw pluginError('UNSUPPORTED', '当前环境不能读取会话状态');
        if (
          a.sessionId !== undefined &&
          (typeof a.sessionId !== 'string' || a.sessionId.length === 0 || a.sessionId.length > 256)
        )
          throw pluginError('INVALID_ARGS', 'sessionId 不合法');
        const current = optionalInvocation()?.sessionId ?? null;
        const target = (a.sessionId as string | undefined) ?? current;
        if (!target) throw pluginError('NO_SESSION', '调用不属于任何会话');
        const visible =
          target === current ||
          (current !== null &&
            manifest.permissions.includes('session.read') &&
            sessions.list(current).some((s) => s.id === target)) ||
          (manifest.permissions.includes('session.readAll') &&
            (sessions.listAll?.() ?? []).some((s) => s.id === target));
        if (!visible) throw pluginError('NOT_FOUND', '没有这个会话');
        return sessions.status(target);
      }
      case 'session.watchTurnEnd':
        permitRead();
        if (typeof a.on !== 'boolean') throw pluginError('INVALID_ARGS', 'on 必须是布尔值');
        return a.on;
      case 'session.focus': {
        permit('session.focus');
        const inv = gestured('切换会话');
        const current = sessionOf(inv);
        if (typeof a.sessionId !== 'string' || a.sessionId.length === 0 || a.sessionId.length > 256)
          throw pluginError('INVALID_ARGS', 'sessionId 不合法');
        const target = a.sessionId;
        // 会话列表只收根会话；coworker 和子代理的 id 是 `<根>::<子>`，
        // 根在列表里就算本项目内的目标，具体怎么切由窗口按会话表决定。
        const visible = this.deps.sessions?.list(current) ?? [];
        const rootId = target.split('::')[0];
        const inProject =
          visible.some((session) => session.id === target) ||
          (rootId !== target && visible.some((session) => session.id === rootId));
        if (!inProject) throw pluginError('NOT_FOUND', '会话不存在或不在本项目');
        await sessionUi()({ sessionId: current, origin: inv.origin ?? null }, 'focusSession', {
          sessionId: target,
        });
        return null;
      }
      case 'session.focusSubagent': {
        permit('session.focus');
        const inv = gestured('查看干员');
        const current = sessionOf(inv);
        const target = a.sessionId;
        if (typeof target !== 'string' || target.length === 0 || target.length > 256)
          throw pluginError('INVALID_ARGS', 'sessionId 不合法');
        if (typeof a.agentId !== 'string' || a.agentId.length === 0 || a.agentId.length > 256)
          throw pluginError('INVALID_ARGS', 'agentId 不合法');
        if (!(this.deps.sessions?.list(current) ?? []).some((s) => s.id === target))
          throw pluginError('NOT_FOUND', '会话不存在或不在本项目');
        await sessionUi()({ sessionId: current, origin: inv.origin ?? null }, 'focusSubagent', {
          sessionId: target,
          agentId: a.agentId,
        });
        return null;
      }
      case 'session.openChildRun': {
        permit('session.focus');
        const inv = gestured('查看干员历史');
        const current = sessionOf(inv);
        const parentId = a.parentId;
        if (typeof parentId !== 'string' || parentId.length === 0 || parentId.length > 256)
          throw pluginError('INVALID_ARGS', 'parentId 不合法');
        if (typeof a.childId !== 'string' || a.childId.length === 0 || a.childId.length > 256)
          throw pluginError('INVALID_ARGS', 'childId 不合法');
        if (!(this.deps.sessions?.list(current) ?? []).some((s) => s.id === parentId))
          throw pluginError('NOT_FOUND', '会话不存在或不在本项目');
        await sessionUi()({ sessionId: current, origin: inv.origin ?? null }, 'openChildRun', {
          parentId,
          childId: a.childId,
        });
        return null;
      }
      case 'session.create': {
        permit('session.create');
        const inv = gestured('新建会话');
        const current = sessionOf(inv);
        if (
          a.text !== undefined &&
          (typeof a.text !== 'string' || utf8Bytes(a.text) > MAX_DRAFT_BYTES)
        )
          throw pluginError('INVALID_ARGS', 'text 不合法或超过 32KB');
        // 插件只能给自己的预设建会话，否则等于替别的插件选预设
        const presetId = a.presetId === undefined ? undefined : String(a.presetId);
        if (presetId !== undefined && parsePluginPresetId(presetId)?.pluginId !== pluginId)
          throw pluginError(
            'INVALID_ARGS',
            `presetId 必须是本插件的预设，格式 plugin:${pluginId}:<预设 id>`
          );
        const created = await sessionUi()(
          { sessionId: current, origin: inv.origin ?? null },
          'createSession',
          { ...(a.text ? { text: a.text } : {}), ...(presetId ? { presetId } : {}) }
        );
        const id = isRecord(created) ? created.sessionId : undefined;
        if (typeof id !== 'string' || id.length === 0)
          throw pluginError('CREATE_FAILED', '新建会话失败');
        return { sessionId: id };
      }
    }
  }

  /** 会话没在运行时让发起窗口拉起它（有历史就恢复），再在就绪期限内重试 */
  private async untilRunning(
    attempt: () => SessionAttempt,
    sessionId: string,
    origin: number | null,
    code: string
  ): Promise<SessionAttempt> {
    let result = attempt();
    if (result.ok || !result.notRunning || !this.deps.wakeSession) return result;
    try {
      await this.deps.wakeSession(sessionId, origin);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw pluginError(code, `${result.error}，启动失败：${reason}`);
    }
    const deadline = this.deps.now() + WAKE_READY_MS;
    while (!result.ok && result.notRunning && this.deps.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, WAKE_POLL_MS));
      result = attempt();
    }
    return result;
  }

  private readClaimRequest(args: Record<string, unknown>): {
    claimKey?: string;
    claimLabel?: string;
    claimGroup?: string;
    claimSubscribedAt?: number;
    claimCandidates?: EventClaimCandidate[];
  } {
    if (
      args.claimKey === undefined &&
      args.claimLabel === undefined &&
      args.claimGroup === undefined &&
      args.claimSubscribedAt === undefined &&
      args.claimCandidates === undefined
    ) {
      return {};
    }
    const claimKey = parseClaimKey(args.claimKey);
    if (!claimKey) throw pluginError('INVALID_ARGS', 'claimKey 不合法');
    const claimLabel = parseClaimLabel(args.claimLabel);
    if (claimLabel === null) throw pluginError('INVALID_ARGS', 'claimLabel 不合法');
    const claimGroup = parseClaimGroup(args.claimGroup);
    if (claimGroup === null) throw pluginError('INVALID_ARGS', 'claimGroup 不合法');
    const claimSubscribedAt = parseClaimSubscribedAt(args.claimSubscribedAt);
    if (claimSubscribedAt === null) throw pluginError('INVALID_ARGS', 'claimSubscribedAt 不合法');
    const claimCandidates = parseClaimCandidates(args.claimCandidates);
    if (claimCandidates === null) throw pluginError('INVALID_ARGS', 'claimCandidates 不合法');
    return {
      claimKey,
      ...(claimLabel !== undefined ? { claimLabel } : {}),
      ...(claimGroup !== undefined ? { claimGroup } : {}),
      ...(claimSubscribedAt !== undefined ? { claimSubscribedAt } : {}),
      ...(claimCandidates !== undefined ? { claimCandidates } : {}),
    };
  }

  private claims(
    pluginId: string,
    api: 'claims.claim' | 'claims.renew' | 'claims.release' | 'claims.list',
    args: Record<string, unknown>,
    inv: Invocation | null
  ): EventClaimAcquireResult | EventClaimView | EventClaimView[] | boolean | null {
    const permit = this.deps.manifest(pluginId)?.permissions.includes('agent.inject');
    if (!permit) throw pluginError('PERMISSION_DENIED', '插件未获授权：agent.inject');
    const claims = this.deps.claims;
    if (!claims) throw pluginError('UNSUPPORTED', '当前环境不能认领对象');
    if (api === 'claims.list') {
      const prefix = this.claimFilter(args.prefix, 'prefix');
      const sessionId = this.claimFilter(args.sessionId, 'sessionId');
      const filterPlugin = this.claimFilter(args.pluginId, 'pluginId');
      return claims.list({
        ...(prefix ? { prefix } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(filterPlugin ? { pluginId: filterPlugin } : {}),
      });
    }
    const key = parseClaimKey(args.key);
    if (!key) throw pluginError('INVALID_ARGS', 'key 不合法');
    const sessionId = this.targetSession(pluginId, args, inv);
    if (api === 'claims.renew') return claims.renew(key, sessionId);
    if (api === 'claims.release') return claims.release(key, sessionId);
    const label = parseClaimLabel(args.label);
    if (label === null) throw pluginError('INVALID_ARGS', 'label 不合法');
    const group = parseClaimGroup(args.group);
    if (group === null) throw pluginError('INVALID_ARGS', 'group 不合法');
    const subscribedAt = parseClaimSubscribedAt(args.subscribedAt);
    if (subscribedAt === null) throw pluginError('INVALID_ARGS', 'subscribedAt 不合法');
    const candidates = parseClaimCandidates(args.candidates);
    if (candidates === null) throw pluginError('INVALID_ARGS', 'candidates 不合法');
    return claims.claim({
      key,
      sessionId,
      pluginId,
      ...(label !== undefined ? { label } : {}),
      ...(group !== undefined ? { group } : {}),
      ...(subscribedAt !== undefined ? { subscribedAt } : {}),
      ...(candidates !== undefined ? { candidates } : {}),
    });
  }

  private claimFilter(raw: unknown, name: string): string | undefined {
    if (raw === undefined) return undefined;
    const parsed = parseClaimKey(raw);
    if (!parsed) throw pluginError('INVALID_ARGS', `${name} 不合法`);
    return parsed;
  }

  private threadsApi(
    pluginId: string,
    api: 'threads.open' | 'threads.bindPr' | 'threads.routePrEvent' | 'threads.list',
    args: Record<string, unknown>,
    inv: Invocation | null
  ):
    | DemandThreadView
    | DemandThreadView[]
    | DemandPrRouteResult
    | Promise<DemandPrRouteResult>
    | null {
    if (!this.deps.manifest(pluginId)?.permissions.includes('agent.inject')) {
      throw pluginError('PERMISSION_DENIED', '插件未获授权：agent.inject');
    }
    const threads = this.deps.threads;
    if (!threads) throw pluginError('UNSUPPORTED', '当前环境没有需求线程');
    if (api === 'threads.list') return threads.list(this.threadFilter(args));
    if (api === 'threads.routePrEvent') {
      const event = parseDemandPrEvent(args);
      if (!event) throw pluginError('INVALID_ARGS', 'PR 事件不合法');
      const thread = threads.findByPr(event.repo, event.number);
      if (thread) this.targetSession(pluginId, { sessionId: thread.sessionId }, inv);
      return threads.routePrEvent(pluginId, event);
    }
    if (api === 'threads.bindPr') {
      const pr = parseDemandPr(args.pr);
      if (!pr) throw pluginError('INVALID_ARGS', 'pr 不合法');
      const threadId = this.optionalId(args.threadId, 'threadId');
      const sessionId = this.optionalId(args.sessionId, 'sessionId');
      if (!threadId && !sessionId) throw pluginError('INVALID_ARGS', '需要 threadId 或 sessionId');
      const thread = threadId
        ? threads.findById(threadId)
        : threads.findActiveBySession(sessionId ?? '')[0];
      if (thread?.pluginId && thread.pluginId !== pluginId) {
        throw pluginError('PERMISSION_DENIED', '线程归属其他插件');
      }
      if (thread) this.targetSession(pluginId, { sessionId: thread.sessionId }, inv);
      return threads.bindPr(
        { ...(threadId ? { threadId } : {}), ...(sessionId ? { sessionId } : {}) },
        pr
      );
    }
    const source = parseDemandSource(args.source);
    if (!source) throw pluginError('INVALID_ARGS', 'source 不合法');
    const sessionId = this.optionalId(args.sessionId, 'sessionId');
    if (!sessionId) throw pluginError('INVALID_ARGS', 'sessionId 不合法');
    const existing = threads.findBySource(source.channel, source.chatId, source.messageId);
    if (existing?.pluginId && existing.pluginId !== pluginId) {
      throw pluginError('PERMISSION_DENIED', '线程归属其他插件');
    }
    this.targetSession(pluginId, { sessionId }, inv);
    const subagentId = this.optionalId(args.subagentId, 'subagentId');
    const secretaryId = this.optionalId(args.secretaryId, 'secretaryId');
    const pr = args.pr === undefined ? undefined : parseDemandPr(args.pr);
    if (args.pr !== undefined && !pr) throw pluginError('INVALID_ARGS', 'pr 不合法');
    return threads.open({
      source,
      sessionId,
      pluginId,
      ...(subagentId ? { subagentId } : {}),
      ...(secretaryId ? { secretaryId } : {}),
      ...(pr ? { pr } : {}),
    });
  }

  private threadFilter(args: Record<string, unknown>): {
    status?: DemandThreadStatus;
    sessionId?: string;
    repo?: string;
    activeOnly?: boolean;
  } {
    const status = args.status === undefined ? undefined : parseDemandStatus(args.status);
    if (args.status !== undefined && !status) throw pluginError('INVALID_ARGS', 'status 不合法');
    const sessionId = this.optionalId(args.sessionId, 'sessionId');
    const repo = this.optionalId(args.repo, 'repo');
    if (args.activeOnly !== undefined && typeof args.activeOnly !== 'boolean') {
      throw pluginError('INVALID_ARGS', 'activeOnly 必须是布尔值');
    }
    return {
      ...(status ? { status } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(repo ? { repo } : {}),
      ...(args.activeOnly === true ? { activeOnly: true } : {}),
    };
  }

  private optionalId(raw: unknown, name: string): string | undefined {
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 256) {
      throw pluginError('INVALID_ARGS', `${name} 不合法`);
    }
    return raw;
  }

  /** 相对项目根解析；先 realpath，再确认仍在授权范围内，不能借符号链接逃出 */
  private async resolveProjectPath(
    inv: Invocation,
    path: unknown,
    scopes: string[],
    forWrite: boolean
  ): Promise<string> {
    if (!inv.projectRoot) throw pluginError('NO_PROJECT', '当前会话没有本机项目目录');
    if (!isPluginRelativePath(path) || path === '.')
      throw pluginError('INVALID_ARGS', 'path 必须是项目内相对路径');
    const normalized = path.replace(/^\.\//, '');
    const root = await realpath(inv.projectRoot);
    const target = resolve(root, normalized);
    const located = forWrite
      ? await this.locateForWrite(target)
      : {
          real: await realpath(target).catch(() => {
            throw pluginError('NOT_FOUND', '文件不存在');
          }),
          missingParent: false,
        };
    if (!within(root, located.real)) throw pluginError('PERMISSION_DENIED', '路径逃出了项目目录');
    const rel = posixRel(root, located.real);
    if (!covered(rel, scopes))
      throw pluginError('PERMISSION_DENIED', `路径不在授权范围：${rel || normalized}`);
    if (located.missingParent) throw pluginError('NOT_FOUND', '父目录不存在');
    return located.real;
  }

  /** 写入目标不存在时，对最近一个已存在的父目录做 realpath，再拼回缺失部分 */
  private async locateForWrite(target: string): Promise<{ real: string; missingParent: boolean }> {
    const existing = await lstat(target).catch((error: unknown) => {
      if (isEnoent(error)) return null;
      throw error;
    });
    if (existing?.isSymbolicLink()) throw pluginError('PERMISSION_DENIED', '不能写入符号链接');
    if (existing) return { real: await realpath(target), missingParent: false };

    const missing: string[] = [];
    let dir = target;
    for (;;) {
      const parent = dirname(dir);
      if (parent === dir) throw pluginError('NOT_FOUND', '父目录不存在');
      missing.unshift(basename(dir));
      dir = parent;
      let st: Awaited<ReturnType<typeof lstat>>;
      try {
        st = await lstat(dir);
      } catch (error) {
        if (isEnoent(error)) continue;
        throw error;
      }
      if (!st.isDirectory() && !st.isSymbolicLink()) throw pluginError('NOT_FOUND', '父目录不存在');
      return {
        real: resolve(await realpath(dir), ...missing),
        missingParent: missing.length > 1,
      };
    }
  }

  private async fetch(
    manifest: ExtensionPluginManifest,
    a: Record<string, unknown>,
    signal: AbortSignal | undefined
  ) {
    const init = isRecord(a.init) ? a.init : {};
    let method = typeof init.method === 'string' ? init.method.toUpperCase() : 'GET';
    const headers: Record<string, string> = {};
    if (isRecord(init.headers))
      for (const [k, v] of Object.entries(init.headers)) if (typeof v === 'string') headers[k] = v;
    const replayable = init.body === undefined || typeof init.body === 'string';
    const bodyEncoding = init.bodyEncoding ?? 'text';
    if (bodyEncoding !== 'text' && bodyEncoding !== 'base64')
      throw pluginError('INVALID_ARGS', 'bodyEncoding 只能是 text 或 base64');
    // base64：插件上传二进制（加密后的图片、文件）时用，宿主解码成原始字节再发
    let body: string | Uint8Array<ArrayBuffer> | undefined =
      typeof init.body !== 'string'
        ? undefined
        : bodyEncoding === 'base64'
          ? new Uint8Array(Buffer.from(init.body, 'base64'))
          : init.body;
    if (
      body !== undefined &&
      (typeof body === 'string' ? utf8Bytes(body) : body.length) > MAX_FETCH_BODY_BYTES
    )
      throw pluginError('TOO_LARGE', '请求体过大');
    const responseType = init.responseType ?? 'text';
    if (responseType !== 'text' && responseType !== 'base64')
      throw pluginError('INVALID_ARGS', 'responseType 只能是 text 或 base64');
    let url = typeof a.url === 'string' ? a.url : '';
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw pluginError('INVALID_ARGS', 'url 不合法');
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
        throw pluginError('INVALID_ARGS', '只支持 http / https');
      if (
        parsed.username ||
        parsed.password ||
        !pluginDomainAllowed(manifest.net.domains, parsed.hostname)
      )
        throw pluginError('PERMISSION_DENIED', `域名未授权：${parsed.hostname}`);
      const response = await this.deps.fetch(parsed.href, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        ...(signal ? { signal } : {}),
        redirect: 'manual',
      });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        const becomeGet =
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && method === 'POST');
        if (becomeGet) {
          method = 'GET';
          body = undefined;
          dropHeader(headers, 'content-type');
          dropHeader(headers, 'content-length');
        } else if (!replayable) {
          throw pluginError('INVALID_ARGS', '重定向无法重放请求体');
        }
        const next = new URL(location, parsed);
        if (next.origin !== parsed.origin) dropSensitiveHeaders(headers);
        url = next.href;
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      const bytes = await readLimitedBody(response);
      const headersOut = Object.fromEntries(response.headers);
      if (responseType === 'base64') {
        return { status: response.status, headers: headersOut, body: bytes.toString('base64') };
      }
      return { status: response.status, headers: headersOut, body: bytes.toString('utf8') };
    }
    throw pluginError('TOO_MANY_REDIRECTS', '重定向次数过多');
  }
}
