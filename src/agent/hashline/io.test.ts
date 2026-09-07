import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHashlineIo } from './io';

const tempDirs: string[] = [];
const tempCwd = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hashline-io-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('createHashlineIo', () => {
  it('本地相对路径在 cwd 下完成 UTF-8 写读往返', async () => {
    const cwd = await tempCwd();
    const io = createHashlineIo({ cwd });
    await io.writeText('a.txt', '你好\n');
    await expect(io.readText('a.txt')).resolves.toBe('你好\n');
    await expect(readFile(join(cwd, 'a.txt'), 'utf8')).resolves.toBe('你好\n');
  });

  it('本地 readFileText 遇到缺失文件返回 undefined', async () => {
    const io = createHashlineIo({ cwd: await tempCwd() });
    await expect(io.readFileText('missing.txt')).resolves.toBeUndefined();
  });

  it('远程读写只调用远程接口并将读取失败转为 undefined', async () => {
    const cwd = await tempCwd();
    const target = resolve(cwd, 'nested/a.txt');
    const readRemote = vi
      .fn<(path: string) => Promise<Buffer>>()
      .mockResolvedValueOnce(Buffer.from('remote\n'))
      .mockRejectedValueOnce(new Error('missing'));
    const writeRemote = vi.fn(async (_path: string, _content: string) => undefined);
    const io = createHashlineIo({ cwd, remote: { readFile: readRemote, writeFile: writeRemote } });
    await expect(io.readText('nested/a.txt')).resolves.toBe('remote\n');
    await io.writeText('nested/a.txt', 'next\n');
    await expect(io.readFileText('nested/a.txt')).resolves.toBeUndefined();
    expect(readRemote).toHaveBeenNthCalledWith(1, target);
    expect(readRemote).toHaveBeenNthCalledWith(2, target);
    expect(writeRemote).toHaveBeenCalledWith(target, 'next\n');
    await expect(readFile(target, 'utf8')).rejects.toThrow();
  });
});
