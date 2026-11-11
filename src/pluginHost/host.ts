import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PluginEventName } from '@shared/extensionPlugins/events';
import { MAX_TOOL_TIMEOUT_MS } from '@shared/extensionPlugins/manifest';
import type {
  MainToPluginHost,
  PluginAgentSource,
  PluginCallMethod,
  PluginErrorShape,
  PluginHostApi,
  PluginHostToMain,
  PluginToolResult,
} from '@shared/extensionPlugins/protocol';
import { pluginToolName } from '@shared/extensionPlugins/toolName';
import { beginChildTracking, installChildProcessHooks, killTrackedChildren } from './children';

export interface HostTransport {
  send(message: PluginHostToMain): void;
  onMessage(handler: (message: unknown) => void): void;
  exit?(code: number): void;
}

interface Invocation {
  id: string;
  controller: AbortController;
}

interface HandlerContext {
  sessionId: string | null;
  projectRoot: string | null;
  /** 来自子会话时的来源；主会话与非会话调用为 null */
  agent: PluginAgentSource | null;
  invocationId: string;
  signal: AbortSignal;
  progress(text: string): Promise<unknown>;
  /** export.call 的调用方插件 id */
  caller?: string;
}

type Handler = (...args: unknown[]) => unknown;
interface TriggerHandlers {
  candidates: (query: string, ctx: HandlerContext) => unknown;
  pick: (item: unknown, ctx: HandlerContext) => unknown;
}

interface Declared {
  known: boolean;
  pluginId: string;
  events: Set<string>;
  schedules: Set<string>;
  exports: Set<string>;
  tools: Set<string>;
  commands: Set<string>;
  dynamicTools: number;
  dynamicCommands: number;
}

const SHUTDOWN_MS = 3_000;
const TOOL = /^[a-z][a-z0-9_]*$/;
const LOCAL_ID = /^[a-z][a-z0-9-]{0,31}$/;

const codedError = (code: string, message: string) => Object.assign(new Error(message), { code });

type LogLevel = Extract<PluginHostToMain, { t: 'log' }>['level'];
const MAX_LOG_CHARS = 8 * 1024;

const formatLogArg = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

const logMessage = (level: LogLevel, args: unknown[]): PluginHostToMain => ({
  t: 'log',
  level,
  message: args.map(formatLogArg).join(' ').slice(0, MAX_LOG_CHARS),
});

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 插件里的 console 输出转给 Main 落盘；桌面端子进程的 stdout 没人看 */
export function captureConsole(
  target: Pick<Console, 'log' | 'info' | 'warn' | 'error' | 'debug'>,
  send: (message: PluginHostToMain) => void
): void {
  const levels: Record<'log' | 'info' | 'warn' | 'error' | 'debug', LogLevel> = {
    log: 'info',
    info: 'info',
    debug: 'info',
    warn: 'warn',
    error: 'error',
  };
  for (const [method, level] of Object.entries(levels) as [keyof typeof levels, LogLevel][])
    target[method] = (...args: unknown[]) => send(logMessage(level, args));
}

function toErrorShape(error: unknown): PluginErrorShape {
  const code = (error as { code?: unknown })?.code;
  return {
    code: typeof code === 'string' ? code : 'PLUGIN_ERROR',
    message: error instanceof Error ? error.message : String(error),
  };
}

function toToolResult(value: unknown, artifacts: string[]): PluginToolResult {
  const withContent = (): PluginToolResult => {
    if (typeof value === 'string') return { content: value };
    if (
      value &&
      typeof value === 'object' &&
      typeof (value as PluginToolResult).content === 'string'
    ) {
      const { content, details } = value as PluginToolResult;
      return details === undefined ? { content } : { content, details };
    }
    return { content: JSON.stringify(value ?? null) };
  };
  const base = withContent();
  return artifacts.length > 0 ? { ...base, artifacts } : base;
}

function names(list: unknown, key: string): Set<string> {
  const set = new Set<string>();
  if (!Array.isArray(list)) return set;
  for (const item of list) {
    if (isRecord(item) && typeof item[key] === 'string') set.add(item[key]);
  }
  return set;
}

function readDeclared(pluginRoot: string, pluginId: string): Declared {
  const empty = (): Declared => ({
    known: false,
    pluginId,
    events: new Set(),
    schedules: new Set(),
    exports: new Set(),
    tools: new Set(),
    commands: new Set(),
    dynamicTools: 0,
    dynamicCommands: 0,
  });
  try {
    const raw = JSON.parse(readFileSync(join(pluginRoot, 'enso-plugin.json'), 'utf8'));
    if (!isRecord(raw)) return empty();
    const contrib = isRecord(raw.contributes) ? raw.contributes : {};
    const dynamic = isRecord(contrib.dynamic) ? contrib.dynamic : {};
    const eventNames = new Set<string>();
    if (Array.isArray(contrib.events)) {
      for (const item of contrib.events) {
        if (isRecord(item) && typeof item.event === 'string') eventNames.add(item.event);
      }
    }
    return {
      known: true,
      pluginId: typeof raw.id === 'string' ? raw.id : pluginId,
      events: eventNames,
      schedules: names(contrib.schedules, 'id'),
      exports: names(contrib.exports, 'name'),
      tools: names(contrib.agentTools, 'name'),
      commands: names(contrib.commands, 'id'),
      dynamicTools: Number.isInteger(dynamic.tools) ? (dynamic.tools as number) : 0,
      dynamicCommands: Number.isInteger(dynamic.commands) ? (dynamic.commands as number) : 0,
    };
  } catch {
    return empty();
  }
}

/**
 * 插件进程本体：自己不持有任何宿主能力，每个 `enso.*` 宿主调用都转回 Main 校验执行。
 * 处理器内的调用经 AsyncLocalStorage 自动带上本次调用 id，Main 据此找到会话与手势。
 */
export function runPluginHost(transport: HostTransport): void {
  installChildProcessHooks();
  beginChildTracking();
  const tools = new Map<string, Handler>();
  const commands = new Map<string, Handler>();
  const triggers = new Map<string, TriggerHandlers>();
  const rendererMethods = new Map<string, Handler>();
  const eventHandlers = new Map<string, Handler>();
  const scheduleHandlers = new Map<string, Handler>();
  const exportHandlers = new Map<string, Handler>();
  const written = new Map<string, string[]>();
  const pendingRegs: Promise<unknown>[] = [];
  const pending = new Map<
    string,
    { resolve(v: unknown): void; reject(e: Error): void; invocationId?: string }
  >();
  const invocations = new Map<string, Invocation>();
  const current = new AsyncLocalStorage<Invocation>();
  let nextId = 1;
  let initialized = false;
  let shuttingDown = false;
  let deactivate: (() => unknown) | null = null;
  let declared: Declared = readDeclared('', '');

  const hostCall = (api: PluginHostApi, args: unknown): Promise<unknown> => {
    const invocation = current.getStore();
    if (invocation?.controller.signal.aborted)
      return Promise.reject(codedError('ABORTED', '调用已取消'));
    const id = `h${nextId++}`;
    return new Promise((resolve, reject) => {
      pending.set(id, {
        resolve: (value) => {
          if (
            api === 'artifact.write' &&
            invocation &&
            isRecord(value) &&
            typeof value.id === 'string'
          ) {
            const list = written.get(invocation.id) ?? [];
            list.push(value.id);
            written.set(invocation.id, list);
          }
          resolve(value);
        },
        reject,
        invocationId: invocation?.id,
      });
      transport.send({
        t: 'call',
        id,
        api,
        args,
        ...(invocation ? { invocationId: invocation.id } : {}),
      });
    });
  };

  const register =
    <T>(map: Map<string, T>, label: string) =>
    (name: unknown, handler: T) => {
      if (typeof name !== 'string' || !handler) throw new TypeError(`${label} 注册参数不合法`);
      map.set(name, handler);
      return () => map.delete(name);
    };

  const dynamicTool = (name: string, handler: Handler, meta: unknown) => {
    if (!declared.known) throw new TypeError('找不到清单，不能动态注册工具');
    if (declared.dynamicTools <= 0) throw new TypeError('清单没有动态工具配额');
    if (!isRecord(meta)) throw new TypeError(`工具 ${name} 需要 meta`);
    const { description, parameters, timeoutMs } = meta;
    if (typeof description !== 'string' || !description.trim() || description.length > 1024)
      throw new TypeError(`工具 ${name} 的 description 不合法`);
    if (!isRecord(parameters) || parameters.type !== 'object')
      throw new TypeError(`工具 ${name} 的 parameters 必须是 type=object`);
    if (
      timeoutMs !== undefined &&
      !(
        typeof timeoutMs === 'number' &&
        Number.isInteger(timeoutMs) &&
        timeoutMs >= 1000 &&
        timeoutMs <= MAX_TOOL_TIMEOUT_MS
      )
    )
      throw new TypeError(`工具 ${name} 的 timeoutMs 不合法`);
    if (
      !TOOL.test(name) ||
      name.includes('__') ||
      pluginToolName(declared.pluginId, name).length > 64
    )
      throw new TypeError(`工具名不合法：${name}`);
    const job = hostCall('contrib.register', {
      kind: 'tool',
      name,
      description,
      parameters,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    }).then(() => {
      tools.set(name, handler);
    });
    pendingRegs.push(job);
    return job.then(() => () => {
      tools.delete(name);
      void hostCall('contrib.unregister', { kind: 'tool', name }).catch(() => {});
    });
  };

  const dynamicCommand = (id: string, handler: Handler, meta: unknown) => {
    if (!declared.known) throw new TypeError('找不到清单，不能动态注册命令');
    if (declared.dynamicCommands <= 0) throw new TypeError('清单没有动态命令配额');
    if (
      !isRecord(meta) ||
      typeof meta.title !== 'string' ||
      !meta.title.trim() ||
      meta.title.length > 60
    )
      throw new TypeError(`命令 ${id} 需要 title`);
    if (!LOCAL_ID.test(id)) throw new TypeError(`命令 id 不合法：${id}`);
    const job = hostCall('contrib.register', { kind: 'command', name: id, title: meta.title }).then(
      () => {
        commands.set(id, handler);
      }
    );
    pendingRegs.push(job);
    return job.then(() => () => {
      commands.delete(id);
      void hostCall('contrib.unregister', { kind: 'command', name: id }).catch(() => {});
    });
  };

  const enso = (pluginId: string, dataDir: string) =>
    Object.freeze({
      pluginId,
      dataDir,
      tools: {
        register: (name: unknown, handler: Handler, meta?: unknown) => {
          if (typeof name !== 'string' || typeof handler !== 'function')
            throw new TypeError('tool 注册参数不合法');
          if (!declared.known || declared.tools.has(name)) {
            tools.set(name, handler);
            return () => tools.delete(name);
          }
          return dynamicTool(name, handler, meta);
        },
      },
      commands: {
        register: (name: unknown, handler: Handler, meta?: unknown) => {
          if (typeof name !== 'string' || typeof handler !== 'function')
            throw new TypeError('command 注册参数不合法');
          if (!declared.known || declared.commands.has(name)) {
            commands.set(name, handler);
            return () => commands.delete(name);
          }
          return dynamicCommand(name, handler, meta);
        },
      },
      triggers: { register: register<TriggerHandlers>(triggers, 'trigger') },
      renderer: { handle: register<Handler>(rendererMethods, 'renderer') },
      events: {
        on: (event: unknown, handler: Handler) => {
          if (typeof event !== 'string' || typeof handler !== 'function')
            throw new TypeError('event 注册参数不合法');
          if (!declared.known || !declared.events.has(event))
            throw new TypeError(`清单未声明事件 ${String(event)}`);
          eventHandlers.set(event, handler);
          return () => eventHandlers.delete(event);
        },
      },
      schedules: {
        register: (id: unknown, handler: Handler) => {
          if (typeof id !== 'string' || typeof handler !== 'function')
            throw new TypeError('schedule 注册参数不合法');
          if (!declared.known || !declared.schedules.has(id))
            throw new TypeError(`清单未声明定时任务 ${String(id)}`);
          scheduleHandlers.set(id, handler);
          return () => scheduleHandlers.delete(id);
        },
      },
      exports: {
        handle: (name: unknown, handler: Handler) => {
          if (typeof name !== 'string' || typeof handler !== 'function')
            throw new TypeError('export 注册参数不合法');
          if (!declared.known || !declared.exports.has(name))
            throw new TypeError(`清单未声明导出 ${String(name)}`);
          exportHandlers.set(name, handler);
          return () => exportHandlers.delete(name);
        },
      },
      plugins: {
        call: (targetId: string, name: string, args?: unknown) =>
          hostCall('plugin.call', { pluginId: targetId, name, args: args ?? {} }),
      },
      artifacts: { write: (input: unknown) => hostCall('artifact.write', input) },
      session: {
        inject: (input: unknown) => hostCall('session.inject', input ?? {}),
        abort: (sessionId?: string) =>
          hostCall('session.abort', sessionId === undefined ? {} : { sessionId }),
        list: (options?: unknown) => hostCall('session.list', options ?? {}),
        status: (sessionId?: string) =>
          hostCall('session.status', sessionId === undefined ? {} : { sessionId }),
        focus: (sessionId: string) => hostCall('session.focus', { sessionId }),
        focusSubagent: (sessionId: string, agentId: string) =>
          hostCall('session.focusSubagent', { sessionId, agentId }),
        openChildRun: (parentId: string, childId: string) =>
          hostCall('session.openChildRun', { parentId, childId }),
        create: (input?: unknown) => hostCall('session.create', input ?? {}),
      },
      host: { capabilities: () => hostCall('host.capabilities', {}) },
      fs: {
        readText: (path: string) => hostCall('fs.readText', { path }),
        writeText: (path: string, text: string) => hostCall('fs.writeText', { path, text }),
      },
      net: {
        fetch: (url: string, init?: unknown) => hostCall('net.fetch', { url, init: init ?? {} }),
      },
      ui: {
        notify: (title: string, body?: string) =>
          hostCall('ui.notify', { title, body: body ?? '' }),
        view: {
          emit: (name: string, data?: unknown) =>
            hostCall('ui.viewEvent', { name, data: data ?? null }),
          open: (input?: string | { viewId?: string; sessionId?: string }) =>
            hostCall('ui.viewOpen', typeof input === 'string' ? { viewId: input } : (input ?? {})),
        },
        clipboard: { writeText: (text: string) => hostCall('ui.clipboard', { text }) },
        status: {
          update: (id: string, patch?: Record<string, unknown>) =>
            hostCall('ui.statusUpdate', { ...(patch ?? {}), id }),
        },
        openExternal: (url: string) => hostCall('ui.openExternal', { url }),
      },
      composer: {
        readDraft: () => hostCall('composer.readDraft', {}),
        insertText: (input: unknown) => hostCall('composer.insertText', input),
        replaceDraft: (input: unknown) => hostCall('composer.replaceDraft', input),
      },
      config: { get: () => hostCall('config.get', {}) },
      mcp: {
        tools: () => hostCall('mcp.tools', {}),
        call: (server: string, tool: string, args?: unknown) =>
          hostCall('mcp.call', { server, tool, args: args ?? {} }),
      },
    });

  const dispatch = async (
    method: PluginCallMethod,
    payload: unknown,
    ctx: HandlerContext
  ): Promise<unknown> => {
    const p = (payload ?? {}) as Record<string, unknown>;
    const lookup = <T>(map: Map<string, T>, key: unknown): T => {
      const handler = typeof key === 'string' ? map.get(key) : undefined;
      if (!handler) throw codedError('NOT_FOUND', `插件没有注册 ${method} ${String(key)}`);
      return handler;
    };
    switch (method) {
      case 'tool.execute':
        return toToolResult(
          await lookup(tools, p.name)(p.args ?? {}, ctx),
          written.get(ctx.invocationId) ?? []
        );
      case 'command.run':
        await lookup(commands, p.id)(ctx);
        return null;
      case 'trigger.candidates':
        return (await lookup(triggers, p.name).candidates(String(p.query ?? ''), ctx)) ?? [];
      case 'trigger.pick':
        return (await lookup(triggers, p.name).pick(p.item, ctx)) ?? null;
      case 'renderer.call':
        return (await lookup(rendererMethods, p.method)(p.args, ctx)) ?? null;
      case 'event.dispatch': {
        const handler = typeof p.event === 'string' ? eventHandlers.get(p.event) : undefined;
        if (!handler) return null;
        return (await handler(p.data, ctx)) ?? null;
      }
      case 'schedule.run': {
        const handler = typeof p.id === 'string' ? scheduleHandlers.get(p.id) : undefined;
        if (!handler) throw codedError('NOT_FOUND', `插件没有注册定时任务 ${String(p.id)}`);
        await handler(ctx);
        return null;
      }
      case 'export.call': {
        const handler = typeof p.name === 'string' ? exportHandlers.get(p.name) : undefined;
        if (!handler) throw codedError('NOT_FOUND', `插件没有导出 ${String(p.name)}`);
        const caller = typeof p.caller === 'string' ? p.caller : undefined;
        return (await handler(p.args, { ...ctx, caller })) ?? null;
      }
    }
  };

  const onCall = async (message: Extract<MainToPluginHost, { t: 'call' }>) => {
    const invocation: Invocation = { id: message.invocationId, controller: new AbortController() };
    invocations.set(invocation.id, invocation);
    const ctx: HandlerContext = {
      sessionId: message.sessionId,
      projectRoot: message.projectRoot ?? null,
      agent: message.agent ?? null,
      invocationId: invocation.id,
      signal: invocation.controller.signal,
      progress: (text: string) => {
        if (message.method !== 'tool.execute') return Promise.resolve(null);
        if (typeof text !== 'string' || text.length === 0) return Promise.resolve(null);
        return hostCall('tool.progress', { text });
      },
    };
    try {
      const value = await current.run(invocation, () =>
        dispatch(message.method, message.payload, ctx)
      );
      transport.send({ t: 'res', id: message.id, ok: true, value });
    } catch (error) {
      transport.send(logMessage('error', [`${message.method} 失败：`, error]));
      transport.send({ t: 'res', id: message.id, ok: false, error: toErrorShape(error) });
    } finally {
      invocations.delete(invocation.id);
      written.delete(invocation.id);
    }
  };

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await Promise.race([
      Promise.resolve()
        .then(() => deactivate?.())
        .then(() => undefined)
        .catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_MS)),
    ]);
    killTrackedChildren();
    transport.exit?.(0);
  };

  const onInit = async (message: Extract<MainToPluginHost, { t: 'init' }>) => {
    if (initialized) return;
    initialized = true;
    declared = readDeclared(message.pluginRoot, message.pluginId);
    try {
      const mod = (await import(pathToFileURL(join(message.pluginRoot, message.main)).href)) as {
        activate?: (api: unknown) => unknown;
        deactivate?: () => unknown;
      };
      if (typeof mod.activate !== 'function') throw new Error('插件 main 未导出 activate');
      if (typeof mod.deactivate === 'function') deactivate = () => mod.deactivate?.();
      await mod.activate(enso(message.pluginId, message.dataDir));
      const settled = await Promise.allSettled(pendingRegs);
      const failed = settled.find((item) => item.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      transport.send({
        t: 'ready',
        registered: {
          tools: [...tools.keys()],
          commands: [...commands.keys()],
          triggers: [...triggers.keys()],
          rendererMethods: [...rendererMethods.keys()],
          events: [...eventHandlers.keys()] as PluginEventName[],
          schedules: [...scheduleHandlers.keys()],
          exports: [...exportHandlers.keys()],
        },
      });
    } catch (error) {
      await Promise.allSettled(pendingRegs);
      transport.send(logMessage('error', ['activate 失败：', error]));
      transport.send({
        t: 'init-error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  transport.onMessage((raw) => {
    const message = raw as MainToPluginHost;
    if (!message || typeof message !== 'object') return;
    switch (message.t) {
      case 'init':
        void onInit(message);
        return;
      case 'call':
        void onCall(message);
        return;
      case 'shutdown':
        void shutdown();
        return;
      case 'cancel': {
        const invocation = invocations.get(message.invocationId);
        if (!invocation) return;
        invocation.controller.abort(codedError('ABORTED', '调用已取消'));
        for (const [id, entry] of pending) {
          if (entry.invocationId !== invocation.id) continue;
          pending.delete(id);
          entry.reject(codedError('ABORTED', '调用已取消'));
        }
        return;
      }
      case 'res': {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (message.ok) entry.resolve(message.value);
        else entry.reject(codedError(message.error.code, message.error.message));
      }
    }
  });
}
