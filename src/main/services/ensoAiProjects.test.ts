import { describe, expect, it } from 'vitest';
import { decodeLocalStorageValue, parseEnsoAiRepositories } from './ensoAiProjects';

describe('decodeLocalStorageValue', () => {
  it('首字节 1 按 UTF-8 解码', () => {
    const value = Buffer.concat([Buffer.from([1]), Buffer.from('[{"a":1}]', 'utf8')]);
    expect(decodeLocalStorageValue(value)).toBe('[{"a":1}]');
  });

  it('首字节 0 按 UTF-16LE 解码', () => {
    const value = Buffer.concat([Buffer.from([0]), Buffer.from('hi', 'utf16le')]);
    expect(decodeLocalStorageValue(value)).toBe('hi');
  });

  it('空 buffer 返回空字符串', () => {
    expect(decodeLocalStorageValue(Buffer.alloc(0))).toBe('');
  });
});

describe('parseEnsoAiRepositories', () => {
  it('解析 enso-repositories 数组为本地仓库路径', () => {
    const text = JSON.stringify([
      { name: 'EnsoAI', path: '/Users/me/project/EnsoAI', id: 'local:/users/me/project/ensoai' },
      { name: 'acemcp', path: '/Users/me/project/acemcp' },
    ]);
    expect(parseEnsoAiRepositories(text)).toEqual([
      '/Users/me/project/EnsoAI',
      '/Users/me/project/acemcp',
    ]);
  });

  it('跳过 remote 仓库与缺失路径的条目', () => {
    const text = JSON.stringify([
      { name: 'remote-repo', path: '/root/happy-server', kind: 'remote', id: 'remote:uuid:/x' },
      { name: 'no-path' },
      { name: 'ok', path: '/tmp/ok' },
    ]);
    expect(parseEnsoAiRepositories(text)).toEqual(['/tmp/ok']);
  });

  it('id 前缀为 remote: 时同样跳过', () => {
    const text = JSON.stringify([
      { name: 'r', path: '/root/x', id: 'remote:b59d:/root/x' },
      { name: 'l', path: '/tmp/l', id: 'local:/tmp/l' },
    ]);
    expect(parseEnsoAiRepositories(text)).toEqual(['/tmp/l']);
  });

  it('非法 JSON 或非数组返回空数组', () => {
    expect(parseEnsoAiRepositories('not-json')).toEqual([]);
    expect(parseEnsoAiRepositories('{"a":1}')).toEqual([]);
  });
});
