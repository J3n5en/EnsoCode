import { describe, expect, it } from 'vitest';
import { parseExtensionPluginManifest } from './manifest';

const base = (patch: Record<string, unknown> = {}, contributes: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  id: 'example.demo',
  name: 'Demo',
  version: '1.0.0',
  main: 'main.js',
  permissions: ['agent.tool'],
  ...patch,
  contributes: {
    agentTools: [{ name: 'lookup', description: 'd', parameters: { type: 'object' } }],
    ...contributes,
  },
});

const parse = (raw: unknown) => parseExtensionPluginManifest(raw, '0.2.12');
const errorsOf = (raw: unknown) => {
  const r = parse(raw);
  return r.ok ? [] : r.errors;
};
const manifestOf = (raw: unknown) => {
  const r = parse(raw);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.manifest;
};

describe('清单：新字段缺省与兼容', () => {
  it('老清单补齐缺省值', () => {
    const m = manifestOf(base());
    expect(m.resident).toBe(false);
    expect(m.env).toEqual([]);
    expect(m.interop).toEqual({ call: [] });
    expect(m.contributes.events).toEqual([]);
    expect(m.contributes.schedules).toEqual([]);
    expect(m.contributes.exports).toEqual([]);
    expect(m.contributes.dynamic).toEqual({ tools: 0, commands: 0 });
    expect(m.contributes.agentTools[0]?.timeoutMs).toBeUndefined();
  });
});

describe('清单：动态贡献', () => {
  it('声明上限；动态工具需要 agent.tool', () => {
    expect(
      manifestOf(base({}, { dynamic: { tools: 10, commands: 5 } })).contributes.dynamic
    ).toEqual({
      tools: 10,
      commands: 5,
    });
    expect(
      errorsOf(base({ permissions: [] }, { agentTools: [], dynamic: { tools: 1 } }))
    ).not.toEqual([]);
  });
  it.each([{ tools: 51 }, { commands: 21 }, { tools: -1 }, { tools: 1.5 }])(
    '拒绝 %j',
    (dynamic) => {
      expect(errorsOf(base({}, { dynamic }))).not.toEqual([]);
    }
  );
});

describe('清单：工具超时', () => {
  it('接受 1000–600000 的整数', () => {
    const m = manifestOf(
      base(
        {},
        {
          agentTools: [
            { name: 'slow', description: 'd', parameters: { type: 'object' }, timeoutMs: 600000 },
          ],
        }
      )
    );
    expect(m.contributes.agentTools[0]?.timeoutMs).toBe(600000);
  });
  it.each([999, 600001, 1.5, '5000'])('拒绝 %j', (timeoutMs) => {
    expect(
      errorsOf(
        base(
          {},
          {
            agentTools: [
              { name: 'x', description: 'd', parameters: { type: 'object' }, timeoutMs },
            ],
          }
        )
      )
    ).not.toEqual([]);
  });
});

describe('清单：事件订阅', () => {
  it('观察型需要 agent.observe，缺省 mode=observe', () => {
    expect(errorsOf(base({}, { events: [{ event: 'session_start' }] })).join()).toContain(
      'agent.observe'
    );
    const m = manifestOf(
      base(
        { permissions: ['agent.tool', 'agent.observe'] },
        { events: [{ event: 'session_start' }, { event: 'before_compact' }] }
      )
    );
    expect(m.contributes.events).toEqual([
      { event: 'session_start', mode: 'observe', failClosed: false },
      { event: 'before_compact', mode: 'observe', failClosed: false },
    ]);
  });

  it('拦截型只用于 tool_call/tool_result/input，需要 agent.intercept', () => {
    const perms = { permissions: ['agent.tool', 'agent.intercept'] };
    expect(
      errorsOf(base({}, { events: [{ event: 'tool_call', mode: 'intercept' }] })).join()
    ).toContain('agent.intercept');
    expect(
      errorsOf(base(perms, { events: [{ event: 'session_start', mode: 'intercept' }] }))
    ).not.toEqual([]);
    const m = manifestOf(
      base(perms, {
        events: [{ event: 'tool_call', mode: 'intercept', failClosed: true, tools: ['bash'] }],
      })
    );
    expect(m.contributes.events).toEqual([
      { event: 'tool_call', mode: 'intercept', failClosed: true, tools: ['bash'] },
    ]);
  });

  it('拒绝未知事件、重复事件、观察型 failClosed、非工具事件带 tools', () => {
    const perms = { permissions: ['agent.tool', 'agent.observe', 'agent.intercept'] };
    expect(errorsOf(base(perms, { events: [{ event: 'nope' }] }))).not.toEqual([]);
    expect(
      errorsOf(base(perms, { events: [{ event: 'input' }, { event: 'input', mode: 'intercept' }] }))
    ).not.toEqual([]);
    expect(
      errorsOf(base(perms, { events: [{ event: 'tool_call', failClosed: true }] }))
    ).not.toEqual([]);
    expect(errorsOf(base(perms, { events: [{ event: 'input', tools: ['bash'] }] }))).not.toEqual(
      []
    );
  });

  it('声明事件必须有 main', () => {
    const { main: _m, ...raw } = base(
      { permissions: ['agent.observe'] },
      { agentTools: [], events: [{ event: 'agent_end' }] }
    );
    expect(errorsOf(raw)).not.toEqual([]);
  });
});

describe('清单：常驻与定时', () => {
  it('resident 与 schedules 需要 process.background', () => {
    expect(errorsOf(base({ resident: true }))).not.toEqual([]);
    expect(errorsOf(base({}, { schedules: [{ id: 'tick', intervalSeconds: 60 }] }))).not.toEqual(
      []
    );
    const m = manifestOf(
      base(
        { resident: true, permissions: ['agent.tool', 'process.background'] },
        { schedules: [{ id: 'tick', intervalSeconds: 300, timeoutMs: 120000 }] }
      )
    );
    expect(m.resident).toBe(true);
    expect(m.contributes.schedules).toEqual([
      { id: 'tick', intervalSeconds: 300, timeoutMs: 120000 },
    ]);
  });

  it.each([59, 86401, 1.5])('拒绝间隔 %j', (intervalSeconds) => {
    expect(
      errorsOf(
        base(
          { permissions: ['agent.tool', 'process.background'] },
          { schedules: [{ id: 'tick', intervalSeconds }] }
        )
      )
    ).not.toEqual([]);
  });
});

describe('清单：插件间调用', () => {
  it('exports 声明可被调用的方法', () => {
    const m = manifestOf(
      base({}, { exports: [{ name: 'search' }, { name: 'slow', timeoutMs: 120000 }] })
    );
    expect(m.contributes.exports).toEqual([
      { name: 'search' },
      { name: 'slow', timeoutMs: 120000 },
    ]);
  });

  it('plugin.call 与 interop.call 必须成对，且不能调用自己', () => {
    expect(errorsOf(base({ permissions: ['agent.tool', 'plugin.call'] }))).not.toEqual([]);
    expect(errorsOf(base({ interop: { call: ['other.plugin'] } }))).not.toEqual([]);
    expect(
      errorsOf(
        base({ permissions: ['agent.tool', 'plugin.call'], interop: { call: ['example.demo'] } })
      )
    ).not.toEqual([]);
    const m = manifestOf(
      base({ permissions: ['agent.tool', 'plugin.call'], interop: { call: ['other.plugin'] } })
    );
    expect(m.interop.call).toEqual(['other.plugin']);
  });
});

describe('清单：环境变量声明', () => {
  it('接受普通变量名', () => {
    expect(manifestOf(base({ env: ['MY_TOOL_HOME', 'JAVA_HOME'] })).env).toEqual([
      'MY_TOOL_HOME',
      'JAVA_HOME',
    ]);
  });
  it.each([
    'ENSO_PLUGIN_DATA',
    'ELECTRON_RUN_AS_NODE',
    'NODE_OPTIONS',
    'NODE_PATH',
    'bad-name',
    '',
  ])('拒绝 %j', (name) => {
    expect(errorsOf(base({ env: [name] }))).not.toEqual([]);
  });
});

describe('清单：类型化配置项', () => {
  it('补齐 type=string，接受 number/boolean/enum/path', () => {
    const m = manifestOf(
      base(
        {},
        {
          configuration: [
            { key: 'token', title: 'T', secret: true },
            { key: 'limit', title: 'L', type: 'number', min: 1, max: 10, default: 5 },
            { key: 'on', title: 'O', type: 'boolean', default: true },
            { key: 'mode', title: 'M', type: 'enum', options: ['a', 'b'], default: 'b' },
            { key: 'dir', title: 'D', type: 'path', pathKind: 'directory' },
          ],
        }
      )
    );
    expect(m.contributes.configuration).toEqual([
      { key: 'token', title: 'T', description: '', secret: true, type: 'string' },
      {
        key: 'limit',
        title: 'L',
        description: '',
        secret: false,
        type: 'number',
        min: 1,
        max: 10,
        default: 5,
      },
      { key: 'on', title: 'O', description: '', secret: false, type: 'boolean', default: true },
      {
        key: 'mode',
        title: 'M',
        description: '',
        secret: false,
        type: 'enum',
        options: ['a', 'b'],
        default: 'b',
      },
      {
        key: 'dir',
        title: 'D',
        description: '',
        secret: false,
        type: 'path',
        pathKind: 'directory',
      },
    ]);
  });

  it.each([
    { key: 'a', title: 'A', type: 'nope' },
    { key: 'a', title: 'A', type: 'enum' },
    { key: 'a', title: 'A', type: 'enum', options: ['x'], default: 'y' },
    { key: 'a', title: 'A', type: 'number', default: 'x' },
    { key: 'a', title: 'A', type: 'number', min: 5, max: 1 },
    { key: 'a', title: 'A', type: 'number', min: 1, default: 0 },
    { key: 'a', title: 'A', type: 'boolean', secret: true },
    { key: 'a', title: 'A', type: 'path', pathKind: 'socket' },
  ])('拒绝不合法配置 %j', (item) => {
    expect(errorsOf(base({}, { configuration: [item] }))).not.toEqual([]);
  });
});

describe('清单：预设模型与工具集', () => {
  const preset = { id: 'deep', name: 'Deep' };
  it('接受模型、推理档位、更严审批与禁用工具', () => {
    const m = manifestOf(
      base(
        {},
        {
          presets: [
            {
              ...preset,
              model: { providerId: 'anthropic', modelId: 'claude-x' },
              thinkingLevel: 'high',
              approvalMode: 'supervised',
              disabledTools: ['bash', 'write'],
            },
          ],
        }
      )
    );
    expect(m.contributes.presets[0]).toMatchObject({
      model: { providerId: 'anthropic', modelId: 'claude-x' },
      thinkingLevel: 'high',
      approvalMode: 'supervised',
      disabledTools: ['bash', 'write'],
    });
  });

  it.each([
    { model: { providerId: 'a' } },
    { thinkingLevel: 'ultra' },
    { approvalMode: 'full' },
    { approvalMode: 'assistant' },
    { disabledTools: ['bad tool'] },
  ])('拒绝 %j', (patch) => {
    expect(errorsOf(base({}, { presets: [{ ...preset, ...patch }] }))).not.toEqual([]);
  });
});

describe('清单：系统集成权限', () => {
  it('认识新权限', () => {
    const m = manifestOf(
      base({ permissions: ['agent.tool', 'ui.clipboard', 'ui.openExternal', 'agent.inject'] })
    );
    expect(m.permissions).toEqual([
      'agent.tool',
      'ui.clipboard',
      'ui.openExternal',
      'agent.inject',
    ]);
  });
});
