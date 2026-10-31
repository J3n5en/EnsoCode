import { describe, expect, it } from 'vitest';
import { parseExtensionPluginManifest } from './manifest';

const base = () => ({
  schemaVersion: 1,
  id: 'example.demo',
  name: 'Demo',
  version: '1.0.0',
  main: 'main.js',
  permissions: ['agent.tool'],
  contributes: {
    agentTools: [
      {
        name: 'lookup',
        description: '查询',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ],
  },
});

const errorsOf = (raw: unknown): string[] => {
  const result = parseExtensionPluginManifest(raw, '0.2.12');
  return result.ok ? [] : result.errors;
};

describe('parseExtensionPluginManifest', () => {
  it('接受合法清单并补齐缺省字段', () => {
    const result = parseExtensionPluginManifest(base(), '0.2.12');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.id).toBe('example.demo');
    expect(result.manifest.contributes.views).toEqual([]);
    expect(result.manifest.contributes.presets).toEqual([]);
    expect(result.manifest.fs).toEqual({ read: [], write: [] });
    expect(result.manifest.net.domains).toEqual([]);
  });

  it.each([null, 'x', 1, []])('拒绝非对象 %j', (raw) => {
    expect(errorsOf(raw).length).toBeGreaterThan(0);
  });

  it.each([undefined, 2, '1'])('拒绝 schemaVersion=%j', (schemaVersion) => {
    expect(errorsOf({ ...base(), schemaVersion })).not.toEqual([]);
  });

  it.each([
    '',
    'Example.demo',
    'example',
    'example.',
    '.example',
    'ex-ample.demo',
    'ex_ample.demo',
    `a.${'b'.repeat(40)}`,
  ])('拒绝非法 id %j', (id) => {
    expect(errorsOf({ ...base(), id })).not.toEqual([]);
  });

  it.each(['/abs/main.js', '../main.js', 'a/../../main.js', 'a\\..\\main.js', 'C:\\main.js', ''])(
    '拒绝逃出插件目录的 main %j',
    (main) => {
      expect(errorsOf({ ...base(), main })).not.toEqual([]);
    }
  );

  it('拒绝 renderer / view entry / skills 中的越界路径', () => {
    expect(
      errorsOf({ ...base(), renderer: '../ui.js', permissions: ['agent.tool', 'ui.slot'] })
    ).not.toEqual([]);
    expect(
      errorsOf({
        ...base(),
        permissions: ['agent.tool', 'ui.view'],
        contributes: {
          ...base().contributes,
          views: [{ id: 'main', title: 'M', entry: '/etc/x.html' }],
        },
      })
    ).not.toEqual([]);
    expect(
      errorsOf({ ...base(), contributes: { ...base().contributes, skills: ['../skills'] } })
    ).not.toEqual([]);
  });

  it('拒绝未知权限', () => {
    expect(errorsOf({ ...base(), permissions: ['agent.tool', 'root'] })).not.toEqual([]);
  });

  it('忽略未知字段但给出提示', () => {
    const result = parseExtensionPluginManifest({ ...base(), marketplace: 'x' }, '0.2.12');
    expect(result.ok && result.warnings.some((w) => w.includes('marketplace'))).toBe(true);
  });

  it.each([
    ['agentTools 缺 agent.tool', { permissions: [] }],
    ['renderer 缺 ui.slot', { renderer: 'ui.js' }],
    [
      'views 缺 ui.view',
      {
        contributes: {
          ...base().contributes,
          views: [{ id: 'main', title: 'M', entry: 'v.html' }],
        },
      },
    ],
    [
      'triggers 缺 ui.slot',
      { contributes: { ...base().contributes, triggers: [{ symbol: '#', name: 'demo' }] } },
    ],
    [
      'mcpServers 缺 mcp.server',
      { contributes: { ...base().contributes, mcpServers: [{ name: 'demo', command: 'node' }] } },
    ],
    ['fs.read 缺权限', { fs: { read: ['.'] } }],
    ['fs.write 缺权限', { fs: { write: ['out'] } }],
    ['net.domains 缺 net.fetch', { net: { domains: ['api.example.com'] } }],
  ])('声明贡献却缺对应权限：%s', (_label, patch) => {
    expect(errorsOf({ ...base(), ...patch })).not.toEqual([]);
  });

  it('有工具、命令或补全来源时必须有 main', () => {
    const { main: _main, ...noMain } = base();
    expect(errorsOf(noMain)).not.toEqual([]);
  });

  it.each(['', 'Lookup', 'a__b', '_a', 'a-b', `t${'x'.repeat(70)}`])(
    '拒绝非法工具名 %j',
    (name) => {
      const tool = { name, description: 'd', parameters: { type: 'object' } };
      expect(errorsOf({ ...base(), contributes: { agentTools: [tool] } })).not.toEqual([]);
    }
  );

  it('拒绝重复工具名', () => {
    const tool = base().contributes.agentTools[0];
    expect(errorsOf({ ...base(), contributes: { agentTools: [tool, tool] } })).not.toEqual([]);
  });

  it.each([undefined, null, 'object', [], { type: 'string' }])(
    '拒绝非对象 parameters %j',
    (parameters) => {
      const tool = { name: 'lookup', description: 'd', parameters };
      expect(errorsOf({ ...base(), contributes: { agentTools: [tool] } })).not.toEqual([]);
    }
  );

  it.each(['..', '../x', '/abs', 'a/../../b'])('拒绝越界 fs 路径 %j', (p) => {
    expect(
      errorsOf({ ...base(), permissions: ['agent.tool', 'fs.read'], fs: { read: [p] } })
    ).not.toEqual([]);
  });

  it.each([
    '*',
    '*.example.com',
    'https://api.example.com',
    'api.example.com:8443',
    'API.example.com',
    '',
  ])('拒绝非精确域名 %j', (domain) => {
    expect(
      errorsOf({ ...base(), permissions: ['agent.tool', 'net.fetch'], net: { domains: [domain] } })
    ).not.toEqual([]);
  });

  it('拒绝非法补全符号', () => {
    // @ 与 / 归宿主（文件提及、命令），插件只能用 #
    for (const symbol of ['$', '@', '/'])
      expect(
        errorsOf({
          ...base(),
          permissions: ['agent.tool', 'ui.slot'],
          contributes: { ...base().contributes, triggers: [{ symbol, name: 'demo' }] },
        })
      ).not.toEqual([]);
  });

  it('MCP env 只接受字符串字面量', () => {
    expect(
      errorsOf({
        ...base(),
        permissions: ['agent.tool', 'mcp.server'],
        contributes: {
          ...base().contributes,
          mcpServers: [{ name: 'demo', command: 'node', env: { A: 1 } }],
        },
      })
    ).not.toEqual([]);
  });

  it('engines.enso 只接受 >=x.y.z，且宿主版本需满足', () => {
    expect(errorsOf({ ...base(), engines: { enso: '>=0.2.0' } })).toEqual([]);
    expect(errorsOf({ ...base(), engines: { enso: '>=9.0.0' } })).not.toEqual([]);
    expect(errorsOf({ ...base(), engines: { enso: '^0.2.0' } })).not.toEqual([]);
  });

  it('长耗时方法：超时只能在 1 秒到 120 秒之间', () => {
    const withMethods = (methods: unknown) => ({
      ...base(),
      contributes: { ...base().contributes, methods },
    });
    const ok = parseExtensionPluginManifest(
      withMethods([{ name: 'enhance', timeoutMs: 90_000 }]),
      '0.2.12'
    );
    expect(ok.ok && ok.manifest.contributes.methods).toEqual([
      { name: 'enhance', timeoutMs: 90_000 },
    ]);
    expect(errorsOf(withMethods([{ name: 'enhance', timeoutMs: 120_001 }]))).not.toEqual([]);
    expect(errorsOf(withMethods([{ name: 'enhance', timeoutMs: 500 }]))).not.toEqual([]);
    expect(errorsOf(withMethods([{ name: 'enhance', timeoutMs: 1.5e3 + 0.5 }]))).not.toEqual([]);
    expect(errorsOf(withMethods([{ name: '9bad', timeoutMs: 5000 }]))).not.toEqual([]);
    expect(
      errorsOf(
        withMethods([
          { name: 'a', timeoutMs: 5000 },
          { name: 'a', timeoutMs: 6000 },
        ])
      )
    ).not.toEqual([]);
  });

  it('mcp.tools 需要 mcp.call 权限，工具名限字母数字与 _ . -', () => {
    expect(errorsOf({ ...base(), mcp: { tools: ['enhance_prompt'] } })).not.toEqual([]);
    const ok = parseExtensionPluginManifest(
      { ...base(), permissions: ['agent.tool', 'mcp.call'], mcp: { tools: ['enhance_prompt'] } },
      '0.2.12'
    );
    expect(ok.ok && ok.manifest.mcp).toEqual({ tools: ['enhance_prompt'] });
    expect(
      errorsOf({ ...base(), permissions: ['agent.tool', 'mcp.call'], mcp: { tools: ['a b'] } })
    ).not.toEqual([]);
    expect(errorsOf({ ...base(), permissions: ['agent.tool', 'mcp.call'] })).not.toEqual([]);
  });

  it('配置项：key 唯一、secret 为布尔，且必须有 main', () => {
    const withConfig = (configuration: unknown, patch: Record<string, unknown> = {}) => ({
      ...base(),
      contributes: { ...base().contributes, configuration },
      ...patch,
    });
    const ok = parseExtensionPluginManifest(
      withConfig([
        { key: 'baseUrl', title: '地址' },
        { key: 'token', title: 'Token', secret: true, description: '只保存在本机' },
      ]),
      '0.2.12'
    );
    expect(ok.ok && ok.manifest.contributes.configuration).toEqual([
      { key: 'baseUrl', title: '地址', description: '', secret: false },
      { key: 'token', title: 'Token', description: '只保存在本机', secret: true },
    ]);
    expect(errorsOf(withConfig([{ key: 'bad-key', title: 'x' }]))).not.toEqual([]);
    expect(errorsOf(withConfig([{ key: 'a', title: 'x', secret: 'yes' }]))).not.toEqual([]);
    expect(
      errorsOf(
        withConfig([
          { key: 'a', title: 'x' },
          { key: 'a', title: 'y' },
        ])
      )
    ).not.toEqual([]);
    expect(
      errorsOf(
        withConfig([{ key: 'a', title: 'x' }], {
          main: undefined,
          permissions: [],
          contributes: { configuration: [{ key: 'a', title: 'x' }] },
        })
      )
    ).not.toEqual([]);
  });

  it('接受预设，并拒绝未声明的 skill、MCP、越界正文和缺少推脱正文', () => {
    const preset = {
      id: 'review',
      name: 'Review',
      skills: ['skills/review'],
      mcpServers: ['lint'],
      instruction: 'prompts/instruction.md',
      systemPrompt: 'prompts/role.md',
      systemPromptTail: 'prompts/tail.md',
      boostPrompt: 'prompts/boost.md',
      refusalRetry: true,
      refusalRetryPrompt: 'prompts/retry.md',
    };
    const raw = {
      ...base(),
      permissions: ['agent.tool', 'mcp.server'],
      contributes: {
        ...base().contributes,
        skills: ['skills/review'],
        mcpServers: [{ name: 'lint', command: 'node', args: ['lint.js'] }],
        presets: [preset],
      },
    };
    const ok = parseExtensionPluginManifest(raw, '0.2.12');
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.manifest.contributes.presets).toEqual([preset]);
    expect(
      errorsOf({
        ...raw,
        contributes: { ...raw.contributes, presets: [{ ...preset, skills: ['skills/other'] }] },
      })
    ).not.toEqual([]);
    expect(
      errorsOf({
        ...raw,
        contributes: { ...raw.contributes, presets: [{ ...preset, mcpServers: ['missing'] }] },
      })
    ).not.toEqual([]);
    expect(
      errorsOf({
        ...raw,
        contributes: {
          ...raw.contributes,
          presets: [{ ...preset, systemPrompt: '../role.md' }],
        },
      })
    ).not.toEqual([]);
    expect(
      errorsOf({
        ...raw,
        contributes: {
          ...raw.contributes,
          presets: [{ ...preset, refusalRetry: true, refusalRetryPrompt: undefined }],
        },
      })
    ).not.toEqual([]);
  });
});
