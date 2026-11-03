import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  type ExtensionPluginManifest,
  type ExtensionPluginPermission,
  isPluginRelativePath,
} from '@shared/extensionPlugins/manifest';
import {
  PLUGIN_INJECT_MAX_CHARS,
  type PluginArtifactInfo,
  type PluginHostApi,
  type PluginHostCapabilities,
  type PluginInjectImage,
  parsePluginInjectImages,
} from '@shared/extensionPlugins/protocol';
import { pluginError } from './process';

export const GESTURE_TTL_MS = 30_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FETCH_BYTES = 5 * 1024 * 1024;
const MAX_DRAFT_BYTES = 32 * 1024;
const MAX_REDIRECTS = 5;
const MAX_MCP_ARGS_BYTES = 64 * 1024;
const MAX_CALL_DEPTH = 3;
const MAX_CLIPBOARD_BYTES = 1024 * 1024;
const OPEN_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const INJECT_PER_WINDOW = 5;
const INJECT_WINDOW_MS = 10_000;

export type ComposerOp = 'readDraft' | 'insertText' | 'replaceDraft';
/** 需要发起窗口配合的会话操作：切换到会话、在发起会话的项目里新建会话 */
export type SessionUiOp = 'focusSession' | 'createSession';

/** 插件看到的会话：只有标识与展示字段，不含路径 */
export interface PluginSessionInfo {
  id: string;
  title: string;
  updatedAt: number;
  running?: boolean;
  archived?: boolean;
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
  writeArtifact?(pluginId: string, input: Record<string, unknown>): PluginArtifactInfo;
  /** 用户是否允许该插件向非发起会话注入 */
  crossSessionInject?(pluginId: string): boolean;
  inject?(
    pluginId: string,
    input: {
      sessionId: string;
      text: string;
      images: PluginInjectImage[];
      deliverAs: 'steer' | 'followUp' | 'nextTurn';
      triggerTurn: boolean;
    }
  ): { ok: true } | { ok: false; error: string };
  abort?(pluginId: string, sessionId: string): { ok: true } | { ok: false; error: string };
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
  registerContrib?(pluginId: string, input: Record<string, unknown>): void;
  unregisterContrib?(pluginId: string, input: Record<string, unknown>): void;
  capabilities?(): PluginHostCapabilities;
  /** 与 sessionId 同项目的主会话；按最近活动排序 */
  sessions?: { list(sessionId: string): PluginSessionInfo[] };
  sessionUi?(
    target: ComposerTarget,
    op: SessionUiOp,
    payload: Record<string, unknown>
  ): Promise<unknown>;
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

export class PluginHostGate {
  readonly invocations: InvocationTable;
  private readonly injects = new Map<string, number[]>();

  constructor(private readonly deps: GateDeps) {
    this.invocations = new InvocationTable(deps.now);
  }

  /** 每个插件 10 秒内最多注入 5 条，防止失控的常驻插件撑爆会话上下文 */
  private admitInject(pluginId: string): void {
    const now = this.deps.now();
    const recent = (this.injects.get(pluginId) ?? []).filter((t) => now - t < INJECT_WINDOW_MS);
    if (recent.length >= INJECT_PER_WINDOW) throw pluginError('RATE_LIMITED', '注入消息过于频繁');
    recent.push(now);
    this.injects.set(pluginId, recent);
  }

  /**
   * 缺省发起会话；指向别的会话要用户授权跨会话。
   * 常驻进程不在调用里（inv 为 null），只能凭跨会话授权指明会话。
   */
  private targetSession(
    pluginId: string,
    a: Record<string, unknown>,
    inv: Invocation | null
  ): string {
    const sessionId = typeof a.sessionId === 'string' ? a.sessionId : (inv?.sessionId ?? null);
    if (!sessionId) throw pluginError('NO_SESSION', '调用不属于任何会话');
    if (sessionId !== inv?.sessionId && !this.deps.crossSessionInject?.(pluginId))
      throw pluginError('PERMISSION_DENIED', '未允许向其他会话发送消息');
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
    const invocation = () => {
      const inv = this.invocations.get(invocationId);
      if (!inv || inv.pluginId !== pluginId)
        throw pluginError('NO_INVOCATION', '此接口只能在宿主发起的调用内使用');
      if (inv.cancelled) throw pluginError('ABORTED', '调用已取消');
      return inv;
    };
    const optionalInvocation = () => (invocationId === undefined ? null : invocation());
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
        if (!this.deps.notify(a.title, body))
          throw pluginError('UNSUPPORTED', '当前环境不支持系统通知');
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
        if (!this.deps.writeArtifact) throw pluginError('UNSUPPORTED', '当前环境不能写产出');
        return this.deps.writeArtifact(pluginId, a);
      }
      case 'session.inject': {
        permit('agent.inject');
        const sessionId = this.targetSession(pluginId, a, optionalInvocation());
        if (
          typeof a.text !== 'string' ||
          a.text.length === 0 ||
          a.text.length > PLUGIN_INJECT_MAX_CHARS
        )
          throw pluginError('INVALID_ARGS', 'text 不合法或超过 32K 字符');
        const images = parsePluginInjectImages(a.images);
        if (!images)
          throw pluginError('INVALID_ARGS', 'images 不合法：最多 4 张 png/jpeg/webp/gif 的 base64');
        const deliverAs = a.deliverAs === undefined ? 'nextTurn' : a.deliverAs;
        if (deliverAs !== 'steer' && deliverAs !== 'followUp' && deliverAs !== 'nextTurn')
          throw pluginError('INVALID_ARGS', 'deliverAs 不合法');
        if (a.triggerTurn !== undefined && typeof a.triggerTurn !== 'boolean')
          throw pluginError('INVALID_ARGS', 'triggerTurn 不合法');
        const bridge = this.deps.inject;
        if (!bridge) throw pluginError('UNSUPPORTED', '当前环境不能注入消息');
        this.admitInject(pluginId);
        const result = bridge(pluginId, {
          sessionId,
          text: a.text,
          images,
          deliverAs,
          triggerTurn: a.triggerTurn === true,
        });
        if (!result.ok) throw pluginError('INJECT_FAILED', result.error);
        return null;
      }
      case 'session.abort': {
        permit('agent.inject');
        const sessionId = this.targetSession(pluginId, a, optionalInvocation());
        if (!this.deps.abort) throw pluginError('UNSUPPORTED', '当前环境不能中止会话');
        const result = this.deps.abort(pluginId, sessionId);
        if (!result.ok) throw pluginError('ABORT_FAILED', result.error);
        return null;
      }
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
        permit('session.read');
        const current = sessionOf(invocation());
        if (!this.deps.sessions) throw pluginError('UNSUPPORTED', '当前环境不能列出会话');
        return { current, sessions: this.deps.sessions.list(current) };
      }
      case 'session.focus': {
        permit('session.focus');
        const inv = gestured('切换会话');
        const current = sessionOf(inv);
        if (typeof a.sessionId !== 'string' || a.sessionId.length === 0 || a.sessionId.length > 256)
          throw pluginError('INVALID_ARGS', 'sessionId 不合法');
        const target = a.sessionId;
        if (!this.deps.sessions?.list(current).some((s) => s.id === target))
          throw pluginError('NOT_FOUND', '会话不存在或不在本项目');
        await sessionUi()({ sessionId: current, origin: inv.origin ?? null }, 'focusSession', {
          sessionId: target,
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
        const created = await sessionUi()(
          { sessionId: current, origin: inv.origin ?? null },
          'createSession',
          a.text ? { text: a.text } : {}
        );
        const id = isRecord(created) ? created.sessionId : undefined;
        if (typeof id !== 'string' || id.length === 0)
          throw pluginError('CREATE_FAILED', '新建会话失败');
        return { sessionId: id };
      }
    }
  }

  /** 相对项目根解析；范围按清单 fs 判定，再经 realpath 确认没有借符号链接逃出项目根 */
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
    if (!covered(normalized, scopes))
      throw pluginError('PERMISSION_DENIED', `路径不在授权范围：${normalized}`);
    const root = await realpath(inv.projectRoot);
    const target = resolve(root, normalized);
    let real: string;
    if (forWrite) {
      const parent = await realpath(dirname(target)).catch(() => {
        throw pluginError('NOT_FOUND', '父目录不存在');
      });
      const existing = await lstat(target).catch(() => null);
      if (existing?.isSymbolicLink()) throw pluginError('PERMISSION_DENIED', '不能写入符号链接');
      real = resolve(parent, normalized.split('/').at(-1) ?? '');
    } else {
      real = await realpath(target).catch(() => {
        throw pluginError('NOT_FOUND', '文件不存在');
      });
    }
    if (!within(root, real)) throw pluginError('PERMISSION_DENIED', '路径逃出了项目目录');
    return real;
  }

  private async fetch(
    manifest: ExtensionPluginManifest,
    a: Record<string, unknown>,
    signal: AbortSignal | undefined
  ) {
    const init = isRecord(a.init) ? a.init : {};
    const method = typeof init.method === 'string' ? init.method.toUpperCase() : 'GET';
    const headers: Record<string, string> = {};
    if (isRecord(init.headers))
      for (const [k, v] of Object.entries(init.headers)) if (typeof v === 'string') headers[k] = v;
    const body = typeof init.body === 'string' ? init.body : undefined;
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
      if (parsed.username || parsed.password || !manifest.net.domains.includes(parsed.hostname))
        throw pluginError('PERMISSION_DENIED', `域名未授权：${parsed.hostname}`);
      const response = await this.deps.fetch(parsed.href, {
        method,
        headers,
        ...(body !== undefined && hop === 0 ? { body } : {}),
        ...(signal ? { signal } : {}),
        redirect: 'manual',
      });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        url = new URL(location, parsed).href;
        continue;
      }
      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > MAX_FETCH_BYTES) throw pluginError('TOO_LARGE', '响应过大');
      const headersOut = Object.fromEntries(response.headers);
      if (responseType === 'base64') {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > MAX_FETCH_BYTES) throw pluginError('TOO_LARGE', '响应过大');
        return { status: response.status, headers: headersOut, body: bytes.toString('base64') };
      }
      const text = await response.text();
      if (utf8Bytes(text) > MAX_FETCH_BYTES) throw pluginError('TOO_LARGE', '响应过大');
      return { status: response.status, headers: headersOut, body: text };
    }
    throw pluginError('TOO_MANY_REDIRECTS', '重定向次数过多');
  }
}
