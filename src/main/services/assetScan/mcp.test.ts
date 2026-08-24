import { describe, expect, it } from 'vitest';
import { parseServerMap } from './mcp';

describe('parseServerMap', () => {
  it('解析 stdio 服务器', () => {
    const result = parseServerMap({
      semble: { command: 'uvx', args: ['--from', 'semble[mcp]', 'semble'], type: 'stdio' },
    });
    expect(result).toEqual([
      {
        name: 'semble',
        transport: 'stdio',
        command: 'uvx',
        args: ['--from', 'semble[mcp]', 'semble'],
        env: {},
        url: undefined,
      },
    ]);
  });

  it('缺少 type 时按有无 url 推断', () => {
    const [stdio] = parseServerMap({ a: { command: '寸止' } });
    expect(stdio.transport).toBe('stdio');

    const [http] = parseServerMap({ b: { url: 'https://mcp.grep.app' } });
    expect(http.transport).toBe('http');
  });

  it('识别 sse 与 streamable-http', () => {
    expect(parseServerMap({ a: { url: 'https://x', type: 'sse' } })[0].transport).toBe('sse');
    expect(parseServerMap({ b: { url: 'https://x', type: 'streamable-http' } })[0].transport).toBe(
      'http'
    );
  });

  it('type 大小写不敏感', () => {
    expect(parseServerMap({ a: { command: 'x', type: 'STDIO' } })[0].transport).toBe('stdio');
  });

  it('serverUrl 作为 url 的别名', () => {
    const [server] = parseServerMap({ a: { serverUrl: 'https://example.com' } });
    expect(server.url).toBe('https://example.com');
  });

  it('既无 command 也无 url 的条目被跳过', () => {
    expect(parseServerMap({ empty: { description: '只有描述' } })).toEqual([]);
  });

  it('env 只保留字符串值', () => {
    const [server] = parseServerMap({
      a: { command: 'x', env: { OK: 'yes', NUM: 123, NESTED: { a: 1 } } },
    });
    expect(server.env).toEqual({ OK: 'yes' });
  });

  it('args 只保留字符串项', () => {
    const [server] = parseServerMap({ a: { command: 'x', args: ['ok', 1, null, 'fine'] } });
    expect(server.args).toEqual(['ok', 'fine']);
  });

  it('url 型服务器不带 command 相关字段', () => {
    const [server] = parseServerMap({
      a: { url: 'https://x', args: ['ignored'], env: { A: 'b' } },
    });
    expect(server.command).toBeUndefined();
    expect(server.args).toBeUndefined();
    expect(server.env).toBeUndefined();
  });

  it('输入不是对象时返回空数组', () => {
    expect(parseServerMap(null)).toEqual([]);
    expect(parseServerMap(undefined)).toEqual([]);
    expect(parseServerMap('nope')).toEqual([]);
  });

  it('跳过值不是对象的条目', () => {
    expect(parseServerMap({ a: null, b: 'x', c: { command: 'ok' } })).toHaveLength(1);
  });
});
