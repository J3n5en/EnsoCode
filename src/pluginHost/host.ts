import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  MainToPluginHost,
  PluginCallMethod,
  PluginErrorShape,
  PluginHostApi,
  PluginHostToMain,
  PluginToolResult,
} from '@shared/extensionPlugins/protocol';

export interface HostTransport {
  send(message: PluginHostToMain): void;
  onMessage(handler: (message: unknown) => void): void;
}

interface Invocation {
  id: string;
  controller: AbortController;
}

interface HandlerContext {
  sessionId: string | null;
  projectRoot: string | null;
  invocationId: string;
  signal: AbortSignal;
}

type Handler = (...args: unknown[]) => unknown;
interface TriggerHandlers {
  candidates: (query: string, ctx: HandlerContext) => unknown;
  pick: (item: unknown, ctx: HandlerContext) => unknown;
}

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

function toToolResult(value: unknown): PluginToolResult {
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
}

/**
 * 插件进程本体：自己不持有任何宿主能力，每个 `enso.*` 宿主调用都转回 Main 校验执行。
 * 处理器内的调用经 AsyncLocalStorage 自动带上本次调用 id，Main 据此找到会话与手势。
 */
export function runPluginHost(transport: HostTransport): void {
  const tools = new Map<string, Handler>();
  const commands = new Map<string, Handler>();
  const triggers = new Map<string, TriggerHandlers>();
  const rendererMethods = new Map<string, Handler>();
  const pending = new Map<
    string,
    { resolve(v: unknown): void; reject(e: Error): void; invocationId?: string }
  >();
  const invocations = new Map<string, Invocation>();
  const current = new AsyncLocalStorage<Invocation>();
  let nextId = 1;
  let initialized = false;

  const hostCall = (api: PluginHostApi, args: unknown): Promise<unknown> => {
    const invocation = current.getStore();
    if (invocation?.controller.signal.aborted)
      return Promise.reject(codedError('ABORTED', '调用已取消'));
    const id = `h${nextId++}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, invocationId: invocation?.id });
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

  const enso = (pluginId: string, dataDir: string) =>
    Object.freeze({
      pluginId,
      dataDir,
      tools: { register: register<Handler>(tools, 'tool') },
      commands: { register: register<Handler>(commands, 'command') },
      triggers: { register: register<TriggerHandlers>(triggers, 'trigger') },
      renderer: { handle: register<Handler>(rendererMethods, 'renderer') },
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
        return toToolResult(await lookup(tools, p.name)(p.args ?? {}, ctx));
      case 'command.run':
        await lookup(commands, p.id)(ctx);
        return null;
      case 'trigger.candidates':
        return (await lookup(triggers, p.name).candidates(String(p.query ?? ''), ctx)) ?? [];
      case 'trigger.pick':
        return (await lookup(triggers, p.name).pick(p.item, ctx)) ?? null;
      case 'renderer.call':
        return (await lookup(rendererMethods, p.method)(p.args, ctx)) ?? null;
    }
  };

  const onCall = async (message: Extract<MainToPluginHost, { t: 'call' }>) => {
    const invocation: Invocation = { id: message.invocationId, controller: new AbortController() };
    invocations.set(invocation.id, invocation);
    const ctx: HandlerContext = {
      sessionId: message.sessionId,
      projectRoot: message.projectRoot ?? null,
      invocationId: invocation.id,
      signal: invocation.controller.signal,
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
    }
  };

  const onInit = async (message: Extract<MainToPluginHost, { t: 'init' }>) => {
    if (initialized) return;
    initialized = true;
    try {
      const mod = (await import(pathToFileURL(join(message.pluginRoot, message.main)).href)) as {
        activate?: (api: unknown) => unknown;
      };
      if (typeof mod.activate !== 'function') throw new Error('插件 main 未导出 activate');
      await mod.activate(enso(message.pluginId, message.dataDir));
      transport.send({
        t: 'ready',
        registered: {
          tools: [...tools.keys()],
          commands: [...commands.keys()],
          triggers: [...triggers.keys()],
          rendererMethods: [...rendererMethods.keys()],
        },
      });
    } catch (error) {
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
