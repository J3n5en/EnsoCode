import { describe, expect, it } from 'vitest';
import { formatMcpHeaderLines, parseMcpHeaderLines, parseMcpImportJson } from './mcpConfig';

describe('MCP 请求头文本（#177）', () => {
  it('按第一个冒号拆，值里的冒号保留；无名或无冒号的行忽略', () => {
    expect(
      parseMcpHeaderLines('Authorization: Bearer a:b=\n  X-Team :  core \nbroken\n: nameless\n')
    ).toEqual({ Authorization: 'Bearer a:b=', 'X-Team': 'core' });
    expect(parseMcpHeaderLines(' \n')).toBeUndefined();
  });

  it('格式化后能原样解析回来', () => {
    const headers = { Authorization: 'Bearer t', 'X-Team': 'core' };
    expect(parseMcpHeaderLines(formatMcpHeaderLines(headers))).toEqual(headers);
    expect(formatMcpHeaderLines(undefined)).toBe('');
  });
});

describe('parseMcpImportJson', () => {
  it('URL 服务器保留 headers（只收字符串值），command 服务器忽略（#177）', () => {
    expect(
      parseMcpImportJson(
        JSON.stringify({
          type: 'http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer t', Bad: 1 },
        })
      )
    ).toMatchObject({
      ok: true,
      servers: [{ transport: 'http', headers: { Authorization: 'Bearer t' } }],
    });
    const stdio = parseMcpImportJson(JSON.stringify({ command: 'x', headers: { A: 'b' } }));
    expect(stdio.ok && stdio.servers[0]).not.toHaveProperty('headers');
    const bare = parseMcpImportJson(JSON.stringify({ url: 'https://x', headers: {} }));
    expect(bare.ok && bare.servers[0]).not.toHaveProperty('headers');
  });

  it('解析 Cursor / Claude Desktop 的 mcpServers 对象', () => {
    const result = parseMcpImportJson(
      JSON.stringify({
        mcpServers: {
          github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
        },
      })
    );
    expect(result).toEqual({
      ok: true,
      servers: [
        {
          name: 'github',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: {},
          url: undefined,
        },
      ],
    });
  });

  it('解析 Codex mcp_servers 与 VS Code servers / mcp.servers', () => {
    expect(
      parseMcpImportJson(JSON.stringify({ mcp_servers: { a: { command: 'x' } } }))
    ).toMatchObject({ ok: true, servers: [{ name: 'a', command: 'x' }] });
    expect(
      parseMcpImportJson(JSON.stringify({ servers: { b: { url: 'https://x' } } }))
    ).toMatchObject({ ok: true, servers: [{ name: 'b', transport: 'http', url: 'https://x' }] });
    expect(
      parseMcpImportJson(JSON.stringify({ mcp: { servers: { c: { command: 'z' } } } }))
    ).toMatchObject({ ok: true, servers: [{ name: 'c', command: 'z' }] });
  });

  it('解析顶层服务器表与单条 command/url 配置', () => {
    expect(
      parseMcpImportJson(JSON.stringify({ grep: { url: 'https://mcp.grep.app' } }))
    ).toMatchObject({ ok: true, servers: [{ name: 'grep', url: 'https://mcp.grep.app' }] });
    expect(
      parseMcpImportJson(
        JSON.stringify({ name: 'fs', command: 'npx', args: ['-y', 'mcp-server-filesystem'] })
      )
    ).toMatchObject({
      ok: true,
      servers: [{ name: 'fs', command: 'npx', args: ['-y', 'mcp-server-filesystem'] }],
    });
    expect(parseMcpImportJson(JSON.stringify({ command: 'uvx', args: ['mcp'] }))).toMatchObject({
      ok: true,
      servers: [{ name: 'uvx', command: 'uvx', args: ['mcp'] }],
    });
  });

  it('解析数组与 mcpServers 数组', () => {
    const result = parseMcpImportJson(
      JSON.stringify({
        mcpServers: [{ name: 'a', command: 'one' }, { url: 'https://two.example' }],
      })
    );
    expect(result).toMatchObject({
      ok: true,
      servers: [
        { name: 'a', command: 'one' },
        { name: 'mcp', url: 'https://two.example' },
      ],
    });
  });

  it('去掉 markdown 代码围栏后再解析', () => {
    const result = parseMcpImportJson('```json\n{"mcpServers":{"a":{"command":"x"}}}\n```');
    expect(result).toMatchObject({ ok: true, servers: [{ name: 'a', command: 'x' }] });
  });

  it('解析 "name": { ... } 片段', () => {
    const result = parseMcpImportJson('"fast-context": { "command": "npx", "args": ["-y", "x"] }');
    expect(result).toMatchObject({
      ok: true,
      servers: [{ name: 'fast-context', command: 'npx', args: ['-y', 'x'] }],
    });
  });

  it('非法 JSON 返回 invalid-json；无有效条目返回 empty', () => {
    expect(parseMcpImportJson('{')).toEqual({ ok: false, error: 'invalid-json' });
    expect(parseMcpImportJson('[]')).toEqual({ ok: false, error: 'empty' });
    expect(parseMcpImportJson('{}')).toEqual({ ok: false, error: 'empty' });
    expect(parseMcpImportJson('null')).toEqual({ ok: false, error: 'empty' });
    expect(parseMcpImportJson(JSON.stringify({ empty: { description: 'nope' } }))).toEqual({
      ok: false,
      error: 'empty',
    });
  });

  it('跳过脏条目，保留可解析的服务器', () => {
    const result = parseMcpImportJson(
      JSON.stringify({
        mcpServers: {
          bad: null,
          ok: { command: 'x', env: { A: '1', N: 2 } },
        },
      })
    );
    expect(result).toMatchObject({
      ok: true,
      servers: [{ name: 'ok', command: 'x', env: { A: '1' } }],
    });
  });
});
