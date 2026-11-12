import { mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReadLedger, withPathRecord, withPriorRead } from './priorRead';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'enso-prior-read-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ReadLedger', () => {
  it('新文件与不存在的路径放行', async () => {
    const ledger = new ReadLedger(dir);
    expect(await ledger.check('new.txt')).toBeUndefined();
  });

  it('已存在但本会话没读过：拒绝覆盖并要求先读', async () => {
    writeFileSync(path.join(dir, 'a.txt'), 'old');
    const ledger = new ReadLedger(dir);
    expect(await ledger.check('a.txt')).toMatch(/has not been read/);
  });

  it('读过且未变：放行；相对、绝对、@ 前缀与软链接指向同一文件', async () => {
    const file = path.join(dir, 'a.txt');
    writeFileSync(file, 'old');
    symlinkSync(file, path.join(dir, 'link.txt'));
    const ledger = new ReadLedger(dir);
    await ledger.record('a.txt');
    expect(await ledger.check(file)).toBeUndefined();
    expect(await ledger.check('@a.txt')).toBeUndefined();
    expect(await ledger.check('link.txt')).toBeUndefined();
  });

  it('读后磁盘内容被改：拒绝并要求重读', async () => {
    const file = path.join(dir, 'a.txt');
    writeFileSync(file, 'old');
    const ledger = new ReadLedger(dir);
    await ledger.record('a.txt');
    writeFileSync(file, 'changed by formatter');
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(await ledger.check('a.txt')).toMatch(/changed on disk/);
    await ledger.record('a.txt');
    expect(await ledger.check('a.txt')).toBeUndefined();
  });

  it('withPriorRead：未读即拒且不执行底层工具，按工具 cwd 解析相对路径', async () => {
    writeFileSync(path.join(dir, 'a.txt'), 'x');
    const ledger = new ReadLedger('/nonexistent');
    let ran = 0;
    const inner = {
      name: 'write',
      label: 'write',
      description: 'write',
      parameters: {},
      async execute() {
        ran++;
        return { content: [{ type: 'text', text: 'ok' }], details: undefined };
      },
    } as unknown as ToolDefinition;
    const paths = (params: unknown) => [(params as { path: string }).path];
    const guarded = withPriorRead(inner, ledger, paths);
    const ctx = { cwd: dir } as never;
    await expect(
      guarded.execute('c1', { path: 'a.txt' }, undefined, undefined, ctx)
    ).rejects.toThrow(/has not been read/);
    expect(ran).toBe(0);
    await ledger.record('a.txt', dir);
    await guarded.execute('c2', { path: 'a.txt' }, undefined, undefined, ctx);
    expect(ran).toBe(1);
  });
});

describe('withPathRecord', () => {
  const tool = (fail = false): ToolDefinition =>
    ({
      name: 't',
      label: 't',
      description: 't',
      parameters: {},
      async execute() {
        if (fail) throw new Error('boom');
        return { content: [{ type: 'text', text: 'ok' }], details: undefined };
      },
    }) as unknown as ToolDefinition;

  it('工具成功后才记录目标路径', async () => {
    writeFileSync(path.join(dir, 'a.txt'), 'x');
    const ledger = new ReadLedger(dir);
    const paths = (params: unknown) => [(params as { path: string }).path];
    await expect(
      withPathRecord(tool(true), ledger, paths).execute(
        'c1',
        { path: 'a.txt' },
        undefined,
        undefined,
        undefined as never
      )
    ).rejects.toThrow('boom');
    expect(await ledger.check('a.txt')).toMatch(/has not been read/);
    await withPathRecord(tool(), ledger, paths).execute(
      'c2',
      { path: 'a.txt' },
      undefined,
      undefined,
      undefined as never
    );
    expect(await ledger.check('a.txt')).toBeUndefined();
  });
});
