import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  type ExtensionPluginManifest,
  type ExtensionPluginPermission,
  isPluginRelativePath,
} from '@shared/extensionPlugins/manifest';
import type { PluginHostApi } from '@shared/extensionPlugins/protocol';
import { pluginError } from './process';

export const GESTURE_TTL_MS = 30_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FETCH_BYTES = 5 * 1024 * 1024;
const MAX_DRAFT_BYTES = 32 * 1024;
const MAX_REDIRECTS = 5;
const MAX_MCP_ARGS_BYTES = 64 * 1024;

export type ComposerOp = 'readDraft' | 'insertText' | 'replaceDraft';

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
  config(pluginId: string): Record<string, string>;
  mcpTools(target: McpTarget, signal: AbortSignal): Promise<McpToolInfo[]>;
  mcpCall(
    target: McpTarget,
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<{ content: string; isError: boolean }>;
  now(): number;
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

  constructor(private readonly deps: GateDeps) {
    this.invocations = new InvocationTable(deps.now);
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
        return this.fetch(manifest, a);
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

  private async fetch(manifest: ExtensionPluginManifest, a: Record<string, unknown>) {
    const init = isRecord(a.init) ? a.init : {};
    const method = typeof init.method === 'string' ? init.method.toUpperCase() : 'GET';
    const headers: Record<string, string> = {};
    if (isRecord(init.headers))
      for (const [k, v] of Object.entries(init.headers)) if (typeof v === 'string') headers[k] = v;
    const body = typeof init.body === 'string' ? init.body : undefined;
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
        redirect: 'manual',
      });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        url = new URL(location, parsed).href;
        continue;
      }
      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > MAX_FETCH_BYTES) throw pluginError('TOO_LARGE', '响应过大');
      const text = await response.text();
      if (utf8Bytes(text) > MAX_FETCH_BYTES) throw pluginError('TOO_LARGE', '响应过大');
      return { status: response.status, headers: Object.fromEntries(response.headers), body: text };
    }
    throw pluginError('TOO_MANY_REDIRECTS', '重定向次数过多');
  }
}
