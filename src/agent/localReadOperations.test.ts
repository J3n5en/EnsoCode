import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createReadToolDefinition } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localReadOperations } from './localReadOperations';

let dir: string;
let file: string;
const escaped: unknown[] = [];
const record = (error: unknown) => escaped.push(error);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'local-read-'));
  file = path.join(dir, 'a.txt');
  writeFileSync(file, 'one\ntwo\nthree\n');
  escaped.length = 0;
  process.on('uncaughtException', record);
  process.on('unhandledRejection', record);
});
afterEach(() => {
  process.off('uncaughtException', record);
  process.off('unhandledRejection', record);
  rmSync(dir, { recursive: true, force: true });
});

/** fs 流的 error 在 nextTick 派发，多等几轮事件循环 */
const drain = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('localReadOperations.createReadStream', () => {
  it('正常读出文件内容', async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of localReadOperations.createReadStream?.(file, {}) ?? [])
      chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString('utf8')).toBe('one\ntwo\nthree\n');
  });

  it('signal 已 abort：迭代以 AbortError 结束，不产生逃逸的 error 事件', async () => {
    const controller = new AbortController();
    controller.abort();
    const consume = async () => {
      for await (const _ of localReadOperations.createReadStream?.(file, {
        signal: controller.signal,
      }) ?? []) {
      }
    };
    await expect(consume()).rejects.toMatchObject({ name: 'AbortError' });
    await drain();
    expect(escaped).toEqual([]);
  });
});

describe('read 工具在打开文件前被中止', () => {
  it('工具以 Operation aborted 失败，没有未处理的异常 / rejection', async () => {
    const controller = new AbortController();
    const tool = createReadToolDefinition(dir, {
      operations: {
        ...localReadOperations,
        // pi 在 access 后检查过一次 aborted，此后到建流之间再无检查：中止落在这个窗口，
        // pi 默认实现会把已 abort 的 signal 交给 FileHandle 流
        detectImageMimeType: async () => {
          controller.abort();
          return null;
        },
      },
    });
    await expect(
      tool.execute('call', { path: file }, controller.signal, undefined, undefined as never)
    ).rejects.toThrow('Operation aborted');
    await drain();
    expect(escaped).toEqual([]);
  });
});
