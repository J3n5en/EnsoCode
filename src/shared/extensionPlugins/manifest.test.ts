import { describe, expect, it } from 'vitest';
import { isNewerPluginVersion, parseExtensionPluginManifest } from './manifest';

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
  it('before_agent_start 可拦截但不能 failClosed；model_select 只能观察', () => {
    const withEvents = (events: unknown, permissions: string[]) => ({
      ...base(),
      permissions: ['agent.tool', ...permissions],
      contributes: { ...base().contributes, events },
    });
    expect(
      errorsOf(
        withEvents(
          [{ event: 'before_agent_start', mode: 'intercept' }, { event: 'model_select' }],
          ['agent.intercept', 'agent.observe']
        )
      )
    ).toEqual([]);
    expect(
      errorsOf(
        withEvents(
          [{ event: 'before_agent_start', mode: 'intercept', failClosed: true }],
          ['agent.intercept']
        )
      )
    ).not.toEqual([]);
    expect(
      errorsOf(withEvents([{ event: 'model_select', mode: 'intercept' }], ['agent.intercept']))
    ).not.toEqual([]);
  });

  it('statusItems 声明输入框底栏状态项，command 必须是本插件命令', () => {
    const withItems = (statusItems: unknown) => ({
      ...base(),
      contributes: {
        ...base().contributes,
        commands: [{ id: 'show', title: 'Show' }],
        statusItems,
      },
    });
    const ok = parseExtensionPluginManifest(
      withItems([
        { id: 'queue', text: '0 待办', tooltip: '队列', command: 'show' },
        { id: 'plain', text: 'idle' },
      ]),
      '0.2.12'
    );
    expect(ok.ok && ok.manifest.contributes.statusItems).toEqual([
      { id: 'queue', text: '0 待办', tooltip: '队列', command: 'show' },
      { id: 'plain', text: 'idle' },
    ]);
    expect(parseExtensionPluginManifest(base(), '0.2.12')).toMatchObject({
      ok: true,
      manifest: { contributes: { statusItems: [] } },
    });
    for (const bad of [
      { id: 'x', text: 'a'.repeat(25) },
      { id: 'x', text: '' },
      { id: 'Bad', text: 'a' },
      { id: 'x', text: 'a', command: 'missing' },
      { id: 'x', text: 'a', tooltip: 1 },
    ]) {
      expect(errorsOf(withItems([bad]))).toContain('状态项不合法');
    }
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, text: 'a' }));
    expect(errorsOf(withItems(many))).toContain('statusItems 最多 8 个');
  });

  it('fileViewers 按扩展名声明查看器，需要 ui.view，扩展名须小写且带点', () => {
    const withViewers = (fileViewers: unknown, permissions = ['agent.tool', 'ui.view']) => ({
      ...base(),
      permissions,
      contributes: { ...base().contributes, fileViewers },
    });
    const ok = parseExtensionPluginManifest(
      withViewers([
        { id: 'draw', title: 'Drawing', entry: 'viewer.html', extensions: ['.excalidraw'] },
        {
          id: 'csv',
          title: 'Table',
          entry: 'csv.html',
          extensions: ['.csv', '.tsv'],
          default: true,
        },
      ]),
      '0.2.12'
    );
    expect(ok.ok && ok.manifest.contributes.fileViewers).toEqual([
      {
        id: 'draw',
        title: 'Drawing',
        entry: 'viewer.html',
        extensions: ['.excalidraw'],
        default: false,
      },
      { id: 'csv', title: 'Table', entry: 'csv.html', extensions: ['.csv', '.tsv'], default: true },
    ]);
    expect(parseExtensionPluginManifest(base(), '0.2.12')).toMatchObject({
      ok: true,
      manifest: { contributes: { fileViewers: [] } },
    });
    const viewer = { id: 'v', title: 'V', entry: 'v.html', extensions: ['.x'] };
    expect(errorsOf(withViewers([viewer], ['agent.tool']))).toContain(
      'fileViewers 需要权限 ui.view'
    );
    for (const bad of [
      { ...viewer, extensions: [] },
      { ...viewer, extensions: ['x'] },
      { ...viewer, extensions: ['.CSV'] },
      { ...viewer, extensions: ['./x'] },
      { ...viewer, entry: 'v.js' },
      { ...viewer, entry: '../v.html' },
      { ...viewer, default: 'yes' },
      { ...viewer, id: 'Bad Id' },
    ]) {
      expect(errorsOf(withViewers([bad]))).toContain('文件查看器不合法');
    }
    expect(errorsOf(withViewers([viewer, viewer]))).toContain('文件查看器 重复：v');
  });

  it('命令可带默认快捷键，必须含 mod/ctrl/alt 且键名合法', () => {
    const withKey = (key: unknown) => ({
      ...base(),
      contributes: { ...base().contributes, commands: [{ id: 'run', title: 'Run', key }] },
    });
    const ok = parseExtensionPluginManifest(withKey('mod+shift+k'), '0.2.12');
    expect(ok.ok && ok.manifest.contributes.commands).toEqual([
      { id: 'run', title: 'Run', key: 'mod+shift+k' },
    ]);
    for (const key of ['alt+f5', 'ctrl+alt+arrowup', 'mod+,']) {
      expect(errorsOf(withKey(key))).toEqual([]);
    }
    for (const key of ['k', 'shift+k', 'mod+', 'mod+foo', 'shift+mod+k', 'MOD+K', 1]) {
      expect(errorsOf(withKey(key))).toContain('命令不合法');
    }
  });

  it('接受合法清单并补齐缺省字段', () => {
    const result = parseExtensionPluginManifest(base(), '0.2.12');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.id).toBe('example.demo');
    expect(result.manifest.contributes.views).toEqual([]);
    expect(result.manifest.contributes.presets).toEqual([]);
    expect(result.manifest.contributes.agentTypes).toEqual([]);
    expect(result.manifest.fs).toEqual({ read: [], write: [] });
    expect(result.manifest.net.domains).toEqual([]);
  });

  it('接受图片 icon，拒绝越界路径和非图片', () => {
    const result = parseExtensionPluginManifest({ ...base(), icon: 'assets/icon.svg' }, '0.2.12');
    expect(result.ok && result.manifest.icon).toBe('assets/icon.svg');
    expect(errorsOf({ ...base(), icon: '../icon.png' })).toContain('icon 路径不合法');
    expect(errorsOf({ ...base(), icon: 'main.js' })).toContain('icon 路径不合法');
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
    expect(errorsOf({ ...base(), permissions: ['agent.tool', 'session.delete'] })).not.toEqual([]);
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

  it('工具可声明 readOnly，非布尔值报错', () => {
    const tool = { ...base().contributes.agentTools[0], readOnly: true };
    const parsed = parseExtensionPluginManifest(
      { ...base(), contributes: { agentTools: [tool] } },
      '0.2.12'
    );
    expect(parsed.ok && parsed.manifest.contributes.agentTools[0]?.readOnly).toBe(true);
    const bad = { ...tool, readOnly: 'yes' };
    expect(errorsOf({ ...base(), contributes: { agentTools: [bad] } })).not.toEqual([]);
  });

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
      { key: 'baseUrl', title: '地址', description: '', secret: false, type: 'string' },
      { key: 'token', title: 'Token', description: '只保存在本机', secret: true, type: 'string' },
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

  it('配置项：错误信息说清违反了哪条规则', () => {
    const reason = (c: unknown) =>
      errorsOf({
        ...base(),
        contributes: { ...base().contributes, configuration: [c] },
      }).join(' ');

    expect(reason({ key: 'a', title: 'x', default: '' })).toContain('default 必须是非空字符串');
    expect(reason({ key: 'a', title: 'x', type: 'nope' })).toContain(
      'type 只能是 string、number、boolean、enum、path'
    );
    expect(reason({ key: 'a', title: 'x', type: 'boolean', default: 'yes' })).toContain(
      'default 必须是布尔值'
    );
    expect(reason({ key: 'a', title: 'x', type: 'enum', options: ['a', 'a'] })).toContain(
      'options 不能有重复项'
    );
    expect(reason({ key: 'a', title: 'x', type: 'enum', options: ['a'], default: 'b' })).toContain(
      'default 必须是 options 里的一项'
    );
    expect(reason({ key: 'a', title: 'x', type: 'number', min: 5, max: 1 })).toContain(
      'min 不能大于 max'
    );
    expect(reason({ key: 'a', title: 'x', type: 'string', min: 1 })).toContain(
      'string 类型不支持 min'
    );
    expect(reason({ key: 'a', title: 'x', type: 'number', secret: true })).toContain(
      'secret 只能用在 string 类型上'
    );
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

  it('接受 workflow 预设文件，预设可圈定；坏路径、坏文件名、重名和未声明引用都拒绝', () => {
    const raw = {
      ...base(),
      contributes: {
        ...base().contributes,
        workflows: ['workflows/triage.js', 'workflows/release-check.js'],
        presets: [
          {
            id: 'review',
            name: 'Review',
            skills: [],
            mcpServers: [],
            workflows: ['workflows/triage.js'],
          },
        ],
      },
    };
    const ok = parseExtensionPluginManifest(raw, '0.2.12');
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.manifest.contributes.workflows).toEqual(raw.contributes.workflows);
    expect(ok.manifest.contributes.presets[0]?.workflows).toEqual(['workflows/triage.js']);
    const withWorkflows = (workflows: unknown) => ({
      ...base(),
      contributes: { ...base().contributes, workflows },
    });
    expect(parseExtensionPluginManifest(base(), '0.2.12')).toMatchObject({
      ok: true,
      manifest: { contributes: { workflows: [] } },
    });
    for (const bad of [
      ['../triage.js'],
      ['workflows/triage.md'],
      ['workflows/Bad Name.js'],
      ['a/triage.js', 'b/triage.js'],
    ])
      expect(errorsOf(withWorkflows(bad))).not.toEqual([]);
    expect(
      errorsOf({
        ...raw,
        contributes: {
          ...raw.contributes,
          presets: [{ ...raw.contributes.presets[0], workflows: ['workflows/missing.js'] }],
        },
      })
    ).not.toEqual([]);
  });

  describe('子代理类型 agentTypes', () => {
    const agentType = {
      name: 'demo:reviewer',
      description: '只读审查',
      systemPrompt: 'agents/reviewer.md',
      tools: 'readonly',
      skills: ['skills/review'],
    };
    const withTypes = (agentTypes: unknown, skills: string[] = ['skills/review']) => ({
      ...base(),
      contributes: { ...base().contributes, skills, agentTypes },
    });

    it('接受合法声明，tools 缺省为 all、skills 缺省为空，不需要 main 和额外权限', () => {
      const ok = parseExtensionPluginManifest(withTypes([agentType]), '0.2.12');
      expect(ok.ok).toBe(true);
      if (!ok.ok) return;
      expect(ok.manifest.contributes.agentTypes).toEqual([agentType]);

      const minimal = parseExtensionPluginManifest(
        {
          schemaVersion: 1,
          id: 'example.demo',
          name: 'Demo',
          version: '1.0.0',
          permissions: [],
          contributes: {
            agentTypes: [{ name: 'helper', description: 'd', systemPrompt: 'a.md' }],
          },
        },
        '0.2.12'
      );
      expect(minimal.ok).toBe(true);
      if (!minimal.ok) return;
      expect(minimal.manifest.contributes.agentTypes).toEqual([
        { name: 'helper', description: 'd', systemPrompt: 'a.md', tools: 'all', skills: [] },
      ]);
    });

    it('拒绝缺少或越界的 systemPrompt', () => {
      expect(errorsOf(withTypes([{ ...agentType, systemPrompt: undefined }]))).not.toEqual([]);
      expect(errorsOf(withTypes([{ ...agentType, systemPrompt: '../x.md' }]))).not.toEqual([]);
      expect(errorsOf(withTypes([{ ...agentType, systemPrompt: '/abs.md' }]))).not.toEqual([]);
      expect(errorsOf(withTypes([{ ...agentType, systemPrompt: '.' }]))).not.toEqual([]);
    });

    it('拒绝非法 name：字符集、长度、保留名与内置类型名', () => {
      for (const name of [
        '',
        'Reviewer',
        'has space',
        '1abc',
        'a:b:c',
        'x'.repeat(65),
        'enso',
        'custom:foo',
        'builtin:foo',
        'worker',
        'scout',
      ])
        expect(errorsOf(withTypes([{ ...agentType, name }])), name).not.toEqual([]);
      expect(errorsOf(withTypes([{ ...agentType, name: `a${'b'.repeat(63)}` }]))).toEqual([]);
    });

    it('拒绝缺少 description、非法 tools 与引用未声明的 skill', () => {
      expect(errorsOf(withTypes([{ ...agentType, description: '' }]))).not.toEqual([]);
      expect(errorsOf(withTypes([{ ...agentType, tools: 'write' }]))).not.toEqual([]);
      expect(errorsOf(withTypes([{ ...agentType, skills: ['skills/other'] }]))).not.toEqual([]);
      expect(errorsOf(withTypes([agentType], []))).not.toEqual([]);
    });

    it('modelMode 可声明 agent_pick，缺省跟随会话，其他值拒绝', () => {
      const ok = parseExtensionPluginManifest(
        withTypes([{ ...agentType, modelMode: 'agent_pick' }]),
        '0.2.12'
      );
      expect(ok.ok && ok.manifest.contributes.agentTypes[0]?.modelMode).toBe('agent_pick');
      expect(errorsOf(withTypes([{ ...agentType, modelMode: 'follow' }]))).toEqual([]);
      expect(errorsOf(withTypes([{ ...agentType, modelMode: 'fixed' }]))).not.toEqual([]);
    });

    it('预设可用 agentTypes 圈定子代理类型，只能引用本插件声明的类型', () => {
      const withPreset = (agentTypes: unknown) => ({
        ...withTypes([agentType]),
        contributes: {
          ...withTypes([agentType]).contributes,
          presets: [{ id: 'mode', name: 'Mode', agentTypes }],
        },
      });
      const ok = parseExtensionPluginManifest(withPreset(['demo:reviewer']), '0.2.12');
      expect(ok.ok && ok.manifest.contributes.presets[0]?.agentTypes).toEqual(['demo:reviewer']);
      expect(errorsOf(withPreset(['demo:other']))).not.toEqual([]);
    });

    it('同插件内 name 不能重复（忽略大小写），且最多 20 个', () => {
      expect(errorsOf(withTypes([agentType, { ...agentType }]))).not.toEqual([]);
      const many = Array.from({ length: 21 }, (_, i) => ({ ...agentType, name: `t${i}` }));
      expect(errorsOf(withTypes(many))).not.toEqual([]);
      expect(errorsOf(withTypes(many.slice(0, 20)))).toEqual([]);
      expect(errorsOf(withTypes({}))).not.toEqual([]);
    });
  });
});

describe('contributes.themes', () => {
  const themePlugin = (themes: unknown) => ({
    schemaVersion: 1,
    id: 'enso.example.catppuccin',
    name: 'Catppuccin',
    version: '1.0.0',
    permissions: [],
    contributes: { themes },
  });

  it('只有主题的插件不需要 main 和权限，css 可选', () => {
    const result = parseExtensionPluginManifest(
      themePlugin([
        {
          id: 'catppuccin',
          name: 'Catppuccin',
          path: 'themes/catppuccin.json',
          css: 'themes/catppuccin.css',
        },
        { id: 'latte', name: 'Latte', path: 'latte.json' },
      ]),
      '0.2.12'
    );
    expect(result.ok && result.manifest.contributes.themes).toEqual([
      {
        id: 'catppuccin',
        name: 'Catppuccin',
        path: 'themes/catppuccin.json',
        css: 'themes/catppuccin.css',
      },
      { id: 'latte', name: 'Latte', path: 'latte.json' },
    ]);
  });

  it('缺省为空数组', () => {
    const result = parseExtensionPluginManifest(base(), '0.2.12');
    expect(result.ok && result.manifest.contributes.themes).toEqual([]);
  });

  it.each<[string, unknown]>([
    ['不是数组', { id: 'a', name: 'A', path: 'a.json' }],
    ['不是对象', ['a']],
    ['id 含斜杠', [{ id: 'a/b', name: 'A', path: 'a.json' }]],
    ['id 大写', [{ id: 'Nord', name: 'A', path: 'a.json' }]],
    ['id 过长', [{ id: `a${'b'.repeat(32)}`, name: 'A', path: 'a.json' }]],
    ['缺名称', [{ id: 'a', path: 'a.json' }]],
    ['path 不是 .json', [{ id: 'a', name: 'A', path: 'a.css' }]],
    ['path 越界', [{ id: 'a', name: 'A', path: '../a.json' }]],
    ['path 绝对路径', [{ id: 'a', name: 'A', path: '/etc/a.json' }]],
    ['path 反斜杠', [{ id: 'a', name: 'A', path: 'themes\\a.json' }]],
    ['css 不是 .css', [{ id: 'a', name: 'A', path: 'a.json', css: 'a.js' }]],
    ['css 越界', [{ id: 'a', name: 'A', path: 'a.json', css: 'x/../../a.css' }]],
    ['css 不是字符串', [{ id: 'a', name: 'A', path: 'a.json', css: true }]],
    [
      'id 重复',
      [
        { id: 'a', name: 'A', path: 'a.json' },
        { id: 'a', name: 'B', path: 'b.json' },
      ],
    ],
  ])('%s 时拒绝', (_label, themes) => {
    expect(errorsOf(themePlugin(themes))).not.toEqual([]);
  });
});

describe('isNewerPluginVersion', () => {
  it('按 x.y.z 数字比较，预发布版低于正式版', () => {
    expect(isNewerPluginVersion('1.10.0', '1.9.3')).toBe(true);
    expect(isNewerPluginVersion('1.0.0', '1.0.0')).toBe(false);
    expect(isNewerPluginVersion('0.9.9', '1.0.0')).toBe(false);
    expect(isNewerPluginVersion('1.0.0', '1.0.0-beta.2')).toBe(true);
    expect(isNewerPluginVersion('1.0.0-beta.2', '1.0.0')).toBe(false);
    expect(isNewerPluginVersion('1.0.0-beta.2', '1.0.0-beta.1')).toBe(true);
    expect(isNewerPluginVersion('v1.2.0', '1.1.0')).toBe(true);
  });

  it('看不懂的版本号只有字面不同才算更新', () => {
    expect(isNewerPluginVersion('2024-06', '2024-05')).toBe(true);
    expect(isNewerPluginVersion('nightly', 'nightly')).toBe(false);
  });
});
