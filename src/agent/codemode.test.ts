import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { McpServerSpawnConfig } from '@shared/types/agent';
import { describe, expect, it, vi } from 'vitest';
import {
  CODEMODE_DEFAULT_TIMEOUT_MS,
  CODEMODE_FORBIDDEN_TOOLS,
  CODEMODE_MAX_NESTED_CALLS,
  CODEMODE_MAX_TIMEOUT_MS,
  CodemodeHost,
  codemodeToolSnapshot,
  looksLikeShellCommand,
  nestedToolCallParent,
  renderMcpServersSection,
  withCodemodeInputs,
  withCodemodeTimeout,
} from './codemode';

type Handler = (event: Record<string, unknown>) => unknown;

function fakePi(activeTools: string[] = []) {
  const handlers = new Map<string, Handler[]>();
  const registered: ToolDefinition[] = [];
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool: (tool: ToolDefinition) => registered.push(tool),
    appendEntry: () => {},
    getAllTools: () => [],
    getActiveTools: () => activeTools,
    getSettings: () => ({}),
  } as unknown as ExtensionAPI;
  const emit = async (event: string, payload: Record<string, unknown>) => {
    let result: unknown;
    for (const handler of handlers.get(event) ?? []) result = (await handler(payload)) ?? result;
    return result as { block?: boolean; reason?: string } | undefined;
  };
  return { pi, registered, emit, handlers };
}

const server = (name: string, toolNames?: string[]): McpServerSpawnConfig => ({
  name,
  transport: 'stdio',
  command: 'x',
  loadMode: 'deferred',
  ...(toolNames ? { toolNames } : {}),
});

const tool = (name: string): ToolDefinition =>
  ({
    name,
    label: name,
    description: name,
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [], details: undefined }),
  }) as unknown as ToolDefinition;

function install(host: CodemodeHost, activeTools?: string[]) {
  const fake = fakePi(activeTools);
  const factory = host.extension as { factory: (pi: ExtensionAPI) => void };
  factory.factory(fake.pi);
  return fake;
}

describe('withCodemodeTimeout', () => {
  it('嵌套 ImageGen 的成功图片随父结果持久化，即使脚本没有输出结果或随后失败', async () => {
    const { emit } = install(new CodemodeHost({ codemode: true, deferredServers: [] }));
    const path = '/tmp/generated.png';
    await emit('tool_result', {
      toolName: 'ImageGen',
      toolCallId: 'nested',
      parentToolCallId: 'p',
      content: [
        {
          type: 'text',
          text: JSON.stringify({ items: [{ status: 'success', path, mimeType: 'image/png' }] }),
        },
      ],
    });
    expect(
      await emit('tool_result', { toolName: 'codemode', toolCallId: 'other', details: {} })
    ).toBeUndefined();
    expect(
      await emit('tool_result', {
        toolName: 'codemode',
        toolCallId: 'p',
        isError: true,
        details: { calls: [] },
      })
    ).toMatchObject({ details: { calls: [], generatedImages: [path] } });
    expect(
      await emit('tool_result', { toolName: 'codemode', toolCallId: 'p', details: {} })
    ).toBeUndefined();
  });

  it('嵌套生成的图片自动进入父结果 content，保留已有内容且各脚本隔离', async () => {
    const { emit } = install(new CodemodeHost({ codemode: true, deferredServers: [] }));
    const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
    const receipt = {
      type: 'text',
      text: JSON.stringify({
        items: [{ status: 'success', path: '/tmp/generated.png', mimeType: 'image/png' }],
      }),
    };
    await emit('tool_result', {
      toolName: 'ImageGen',
      toolCallId: 'p/1',
      parentToolCallId: 'p',
      content: [receipt, image],
    });
    expect(
      await emit('tool_result', { toolName: 'codemode', toolCallId: 'q', content: [], details: {} })
    ).toBeUndefined();
    const output = { type: 'text', text: 'Script failed after generating' };
    const parent = await emit('tool_result', {
      toolName: 'codemode',
      toolCallId: 'p',
      content: [output],
      details: { calls: [] },
      isError: true,
    });
    expect(parent).toMatchObject({
      content: [output, image],
      details: {
        calls: [],
        generatedImages: ['/tmp/generated.png'],
      },
    });
    expect(
      await emit('tool_result', { toolName: 'codemode', toolCallId: 'p', content: [], details: {} })
    ).toBeUndefined();
  });

  it('脚本已主动输出同一图片时不重复追加附件', async () => {
    const { emit } = install(new CodemodeHost({ codemode: true, deferredServers: [] }));
    const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
    await emit('tool_result', {
      toolName: 'ImageGen',
      toolCallId: 'p/1',
      parentToolCallId: 'p',
      content: [image],
    });
    expect(
      await emit('tool_result', {
        toolName: 'codemode',
        toolCallId: 'p',
        content: [image],
        details: {},
      })
    ).toMatchObject({ content: [image] });
  });

  const header = (code: string) => JSON.parse(code.split('\n')[0].slice('// @options:'.length));

  it('无 options 行时补默认超时，正文不变', () => {
    const out = withCodemodeTimeout('return 1;');
    expect(header(out)).toEqual({ timeout_ms: CODEMODE_DEFAULT_TIMEOUT_MS });
    expect(out.split('\n').slice(1).join('\n')).toBe('return 1;');
  });

  it('保留其他字段，缺 timeout 补默认，超上限钳位', () => {
    expect(
      header(withCodemodeTimeout('// @options: {"max_output_tokens": 500}\nreturn 1;'))
    ).toEqual({ max_output_tokens: 500, timeout_ms: CODEMODE_DEFAULT_TIMEOUT_MS });
    expect(header(withCodemodeTimeout('// @options: {"timeout_ms": 99999999}\nreturn 1;'))).toEqual(
      { timeout_ms: CODEMODE_MAX_TIMEOUT_MS }
    );
    expect(header(withCodemodeTimeout('// @options: {"timeout_ms": 1000}\nx'))).toEqual({
      timeout_ms: 1000,
    });
  });

  it('坏 options 原样返回，交给 pi 报错', () => {
    const bad = '// @options: {oops\nreturn 1;';
    expect(withCodemodeTimeout(bad)).toBe(bad);
  });
});

describe('withCodemodeInputs', () => {
  const evalInputs = (declaration: string) => new Function(`${declaration} return inputs;`)();

  it('没有输入块时原样返回', () => {
    expect(withCodemodeInputs('return 1;')).toEqual({ code: 'return 1;' });
  });

  it('heredoc 原文不转义地进 inputs，块行替换为空行以保持行号', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 原文块里的模板字面量正是要验证的场景
    const patch = "*** Begin Patch\nconst x = `${a}` + '\\n';\n*** End Patch";
    const code = [
      '// @options: {"timeout_ms": 1000}',
      "// @input: patch <<'EOF'",
      ...patch.split('\n'),
      'EOF',
      '// @input: note <<END',
      'line "one"',
      'END',
      'return inputs.patch;',
    ].join('\n');
    const out = withCodemodeInputs(code);
    if (!('code' in out)) throw new Error(out.error);
    const lines = out.code.split('\n');
    expect(lines).toHaveLength(code.split('\n').length);
    expect(lines[0]).toBe('// @options: {"timeout_ms": 1000}');
    expect(lines.at(-1)).toBe('return inputs.patch;');
    expect(lines[1].startsWith('const inputs = Object.freeze(')).toBe(true);
    expect(evalInputs(lines[1])).toEqual({ patch, note: 'line "one"' });
  });

  it('未闭合、重名或非法名字返回错误', () => {
    expect(withCodemodeInputs("// @input: a <<'EOF'\nx")).toMatchObject({
      error: expect.stringContaining('EOF'),
    });
    expect(
      withCodemodeInputs("// @input: a <<'E'\n1\nE\n// @input: a <<'E'\n2\nE\nreturn 1;")
    ).toMatchObject({ error: expect.stringContaining('a') });
    expect(withCodemodeInputs("// @input: 1bad <<'E'\nx\nE")).toMatchObject({
      error: expect.stringContaining('1bad'),
    });
  });
});

describe('looksLikeShellCommand', () => {
  it('识别 shell，放过 JS', () => {
    expect(looksLikeShellCommand('git status')).toBe(true);
    expect(looksLikeShellCommand('const x = await tools.read({path:"a"}); return x;')).toBe(false);
    expect(looksLikeShellCommand('ls()')).toBe(false);
  });
});

describe('nestedToolCallParent', () => {
  it('只认 pi 的 <parent>/<n>', () => {
    expect(nestedToolCallParent('call_1/3')).toBe('call_1');
    expect(nestedToolCallParent('a/1/2')).toBe('a/1');
    expect(nestedToolCallParent('toolu_01')).toBeUndefined();
    expect(nestedToolCallParent('functions.read:0')).toBeUndefined();
    expect(nestedToolCallParent('/1')).toBeUndefined();
  });
});

describe('renderMcpServersSection', () => {
  it('列出按需 server 与缓存工具名，无 server 时不出段', () => {
    expect(renderMcpServersSection([], 'codemode')).toBeUndefined();
    const section = renderMcpServersSection([server('my docs', ['search', 'get'])], 'codemode');
    expect(section).toContain('- mcp__my_docs: search, get');
    expect(section).toContain('searchTools');
    expect(renderMcpServersSection([server('a')], 'tool_search')).toContain('tool_search');
  });

  it('配置了 description 的 server 带一行摘要，超长截断', () => {
    const withDescription = {
      ...server('docs', ['search']),
      description: 'Internal docs\nsecond line',
    };
    expect(renderMcpServersSection([withDescription], 'codemode')).toContain(
      '- mcp__docs: Internal docs. Tools: search'
    );
    const long = { ...server('long'), description: 'x'.repeat(400) };
    const line = renderMcpServersSection([long], 'codemode')?.split('\n').at(-1) ?? '';
    expect(line.length).toBeLessThanOrEqual(270);
    expect(line.endsWith('…')).toBe(true);
  });
});

describe('CodemodeHost', () => {
  it('开 codemode 时注册 codemode 并激活；关 codemode 有按需 server 时改用 tool_search', () => {
    const on = new CodemodeHost({ codemode: true, deferredServers: [] });
    expect(on.activeToolNames()).toEqual(['codemode']);
    expect(install(on).registered).toEqual([
      expect.objectContaining({ name: 'codemode', defaultActive: true }),
    ]);

    const search = new CodemodeHost({ codemode: false, deferredServers: [server('a')] });
    expect(search.activeToolNames()).toEqual(['tool_search']);
    expect(install(search).registered.map((t) => t.name)).toEqual(['tool_search']);

    const off = new CodemodeHost({ codemode: false, deferredServers: [] });
    expect(off.activeToolNames()).toEqual([]);
    expect(install(off).registered).toEqual([]);
  });

  it('拦截 shell / apply_patch 文档，给脚本补超时', async () => {
    const { emit } = install(new CodemodeHost({ codemode: true, deferredServers: [] }));
    expect(
      await emit('tool_call', {
        toolName: 'codemode',
        toolCallId: 'c',
        input: { code: 'git status' },
      })
    ).toMatchObject({ block: true });
    expect(
      await emit('tool_call', {
        toolName: 'codemode',
        toolCallId: 'c',
        input: { code: '*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch' },
      })
    ).toMatchObject({ block: true });
    const input = { code: 'return 1;' };
    expect(
      await emit('tool_call', { toolName: 'codemode', toolCallId: 'c', input })
    ).toBeUndefined();
    expect(input.code.startsWith('// @options:')).toBe(true);
  });

  it('tool_call 展开 @input 块，坏块直接拦下；工具描述写明用法', async () => {
    const { emit, registered } = install(new CodemodeHost({ codemode: true, deferredServers: [] }));
    expect(registered.find((t) => t.name === 'codemode')?.description).toContain('// @input:');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 原文块里的模板字面量正是要验证的场景
    const input = { code: "// @input: body <<'EOF'\n`raw` ${x}\nEOF\nreturn inputs.body;" };
    expect(
      await emit('tool_call', { toolName: 'codemode', toolCallId: 'c', input })
    ).toBeUndefined();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 同上
    expect(input.code).toContain('const inputs = Object.freeze({"body":"`raw` ${x}"});');
    expect(input.code).not.toContain('@input');
    expect(
      await emit('tool_call', {
        toolName: 'codemode',
        toolCallId: 'c',
        input: { code: "// @input: body <<'EOF'\nunterminated" },
      })
    ).toMatchObject({ block: true, reason: expect.stringContaining('EOF') });
  });

  it('工具描述只给通用说明，不点名具体禁用工具', () => {
    const { registered } = install(new CodemodeHost({ codemode: true, deferredServers: [] }));
    for (const description of [
      registered.find((t) => t.name === 'codemode')?.description ?? '',
      codemodeToolSnapshot().description,
    ]) {
      expect(description).toContain('cannot be called from codemode scripts');
      for (const name of CODEMODE_FORBIDDEN_TOOLS) expect(description).not.toContain(`\`${name}\``);
    }
  });

  it('禁用工具段只列本会话已声明的禁用工具，无则不写', async () => {
    const sectionOf = async (active: string[]) => {
      const { emit } = install(new CodemodeHost({ codemode: true, deferredServers: [] }), active);
      const sections: Record<string, string> = {};
      await emit('before_agent_start', { systemPromptOptions: { sections } });
      return sections.codemode_forbidden_tools;
    };
    const text = await sectionOf(['read', 'todo', 'subagent']);
    expect(text).toContain('`subagent`, `todo`');
    expect(text).not.toContain('`read`');
    expect(text).not.toContain('submit_plan');
    expect(await sectionOf(['read'])).toBeUndefined();
  });

  it('嵌套调用禁止编排类工具，并按父调用限次；父调用结束清零', async () => {
    const { emit } = install(new CodemodeHost({ codemode: true, deferredServers: [] }));
    const nested = (toolName: string, n: number) =>
      emit('tool_call', {
        toolName,
        toolCallId: `p/${n}`,
        parentToolCallId: 'p',
        input: {},
      });
    expect(await nested('subagent', 1)).toMatchObject({ block: true });
    // send_image 的结果只认会话里直接的 send_image 工具结果，脚本里调用发不出图
    expect(await nested('send_image', 1)).toMatchObject({ block: true });
    expect(await nested('read', 2)).toBeUndefined();
    for (let i = 3; i <= CODEMODE_MAX_NESTED_CALLS + 1; i++) await nested('read', i);
    expect(await nested('read', 999)).toMatchObject({ block: true });
    await emit('tool_result', { toolName: 'codemode', toolCallId: 'p' });
    expect(await nested('read', 1000)).toBeUndefined();
    expect(
      await emit('tool_call', { toolName: 'read', toolCallId: 'x', input: {} })
    ).toBeUndefined();
  });

  it('按需 server 在首次 codemode 调用时连接并以 deferred 注册，失败的下次重试', async () => {
    const host = new CodemodeHost({
      codemode: true,
      deferredServers: [server('a'), server('b')],
    });
    let bReady = false;
    const load = vi.fn(async (s: McpServerSpawnConfig) =>
      s.name === 'a' ? [tool('mcp__a__x')] : bReady ? [tool('mcp__b__y')] : null
    );
    host.bindDeferredTools(load);
    const { emit, registered } = install(host);
    expect(load).not.toHaveBeenCalled();
    const call = () =>
      emit('tool_call', { toolName: 'codemode', toolCallId: 'c', input: { code: 'return 1;' } });
    await call();
    expect(registered.filter((t) => t.name.startsWith('mcp__'))).toEqual([
      expect.objectContaining({ name: 'mcp__a__x', exposure: 'deferred' }),
    ]);
    bReady = true;
    await call();
    await call();
    expect(registered.filter((t) => t.name.startsWith('mcp__')).map((t) => t.name)).toEqual([
      'mcp__a__x',
      'mcp__b__y',
    ]);
    expect(load.mock.calls.filter(([s]) => s.name === 'a')).toHaveLength(1);
  });

  it('未启用 codemode 时也能把后来连上的常驻 MCP 工具补进当前会话，同名不重复注册', () => {
    const host = new CodemodeHost({ codemode: false, deferredServers: [] });
    const { registered } = install(host);
    const search = tool('mcp__notion__search');
    expect(host.adoptDirectTools([search])).toEqual(['mcp__notion__search']);
    expect(registered).toEqual([
      expect.objectContaining({ name: search.name, defaultActive: true }),
    ]);
    expect(host.adoptDirectTools([search, tool('mcp__notion__read')])).toEqual([
      'mcp__notion__read',
    ]);
    expect(registered.map((item) => item.name)).toEqual([
      'mcp__notion__search',
      'mcp__notion__read',
    ]);
  });

  it('按需 server 清单写进 mcp_servers 段', async () => {
    const { emit } = install(
      new CodemodeHost({ codemode: true, deferredServers: [server('a', ['x'])] })
    );
    const sections: Record<string, string> = {};
    await emit('before_agent_start', { systemPromptOptions: { sections } });
    expect(sections.mcp_servers).toContain('- mcp__a: x');
  });
});
