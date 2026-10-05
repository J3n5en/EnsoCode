import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { McpServerSpawnConfig } from '@shared/types/agent';
import { describe, expect, it, vi } from 'vitest';
import {
  CODEMODE_DEFAULT_TIMEOUT_MS,
  CODEMODE_MAX_NESTED_CALLS,
  CODEMODE_MAX_TIMEOUT_MS,
  CodemodeHost,
  looksLikeShellCommand,
  nestedToolCallParent,
  renderMcpServersSection,
  withCodemodeTimeout,
} from './codemode';

type Handler = (event: Record<string, unknown>) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const registered: ToolDefinition[] = [];
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool: (tool: ToolDefinition) => registered.push(tool),
    appendEntry: () => {},
    getAllTools: () => [],
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

function install(host: CodemodeHost) {
  const fake = fakePi();
  const factory = host.extension as { factory: (pi: ExtensionAPI) => void };
  factory.factory(fake.pi);
  return fake;
}

describe('withCodemodeTimeout', () => {
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

  it('按需 server 清单写进 mcp_servers 段', async () => {
    const { emit } = install(
      new CodemodeHost({ codemode: true, deferredServers: [server('a', ['x'])] })
    );
    const sections: Record<string, string> = {};
    await emit('before_agent_start', { systemPromptOptions: { sections } });
    expect(sections.mcp_servers).toContain('- mcp__a: x');
  });
});
