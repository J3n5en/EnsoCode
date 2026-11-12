/** 写入插件目录的 enso-testing.mjs。零依赖，给 node --test 挂载 main.mjs。 */
export const PLUGIN_TESTING_SOURCE = `// 零依赖宿主桩，供 node --test 调用 main.mjs 的 activate。
export async function mountMain(activate, options = {}) {
  const calls = [];
  const host = options.host ?? {};
  const tools = new Map();
  const commands = new Map();
  const events = new Map();
  const schedules = new Map();
  const methods = new Map();
  const exportsMap = new Map();
  const triggers = new Map();

  const call = (api, args) => {
    calls.push({ api, args });
    const fn = host[api];
    if (typeof fn === 'function') return fn(...args);
    if (api === 'config.get') return options.config ?? {};
    return undefined;
  };

  const register = (map, key, handler) => {
    map.set(key, handler);
    return () => {
      if (map.get(key) === handler) map.delete(key);
    };
  };

  const enso = {
    pluginId: options.pluginId ?? 'test.plugin',
    dataDir: options.dataDir ?? '.',
    tools: { register: (name, handler) => register(tools, name, handler) },
    commands: { register: (id, handler) => register(commands, id, handler) },
    events: { on: (event, handler) => register(events, event, handler) },
    schedules: { register: (id, handler) => register(schedules, id, handler) },
    renderer: { handle: (name, handler) => register(methods, name, handler) },
    exports: { handle: (name, handler) => register(exportsMap, name, handler) },
    triggers: { register: (symbol, handler) => register(triggers, symbol, handler) },
    ui: {
      notify: (...args) => call('ui.notify', args),
      view: {
        emit: (...args) => call('ui.view.emit', args),
        open: (...args) => call('ui.view.open', args),
      },
      status: { update: (...args) => call('ui.status.update', args) },
      clipboard: { writeText: (...args) => call('ui.clipboard.writeText', args) },
      openExternal: (...args) => call('ui.openExternal', args),
    },
    fs: {
      readText: (...args) => call('fs.readText', args),
      writeText: (...args) => call('fs.writeText', args),
    },
    net: { fetch: (...args) => call('net.fetch', args) },
    config: { get: (...args) => call('config.get', args) },
    artifacts: { write: (...args) => call('artifacts.write', args) },
    session: {
      inject: (...args) => call('session.inject', args),
      abort: (...args) => call('session.abort', args),
      list: (...args) => call('session.list', args),
      status: (...args) => call('session.status', args),
      focus: (...args) => call('session.focus', args),
      create: (...args) => call('session.create', args),
    },
    composer: {
      readDraft: (...args) => call('composer.readDraft', args),
      insertText: (...args) => call('composer.insertText', args),
      replaceDraft: (...args) => call('composer.replaceDraft', args),
    },
    mcp: {
      tools: (...args) => call('mcp.tools', args),
      call: (...args) => call('mcp.call', args),
    },
    plugins: { call: (...args) => call('plugins.call', args) },
    host: { capabilities: (...args) => call('host.capabilities', args) },
  };

  await activate(enso);

  const ctxOr = (ctx) => ctx ?? { sessionId: 'test-session', progress: async () => {} };
  const invoke = async (map, kind, key, args) => {
    const handler = map.get(key);
    if (typeof handler !== 'function') throw new Error('未注册: ' + kind + ' ' + key);
    return await handler(...args);
  };

  return {
    enso,
    calls,
    tool: (name, args, ctx) => invoke(tools, 'tool', name, [args, ctxOr(ctx)]),
    command: (id, ctx) => invoke(commands, 'command', id, [ctxOr(ctx)]),
    fire: (event, data, ctx) => invoke(events, 'event', event, [data, ctxOr(ctx)]),
    schedule: (id) => invoke(schedules, 'schedule', id, [ctxOr()]),
    method: (name, args, ctx) => invoke(methods, 'method', name, [args, ctxOr(ctx)]),
  };
}
`;
