import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PrivacyMaskRecord } from '@shared/privacyMask/report';
import { describe, expect, it, vi } from 'vitest';
import { appendLedger, collectRecords, extractSessionRecords, readLedger } from './records';

// readFile 默认透传真实实现；并发用例里单次注入「读出后延迟」，把交错时序固定下来
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

const DAY = 86_400_000;
const report = { hits: [], blocked: false, restored: 1 };
const record = (at: number, source: PrivacyMaskRecord['source'] = 'aux'): PrivacyMaskRecord => ({
  at,
  provider: 'p',
  model: 'm',
  source,
  report,
});

describe('privacy mask records', () => {
  it('extracts mask entries from session jsonl, skipping junk', () => {
    const lines = [
      JSON.stringify({ type: 'session', id: 's' }),
      JSON.stringify({
        type: 'custom',
        customType: 'enso-privacy-mask',
        data: record(5, 'session'),
      }),
      '{broken enso-privacy-mask',
      JSON.stringify({ type: 'custom', customType: 'enso-privacy-mask', data: { at: 'x' } }),
      JSON.stringify({ type: 'custom', customType: 'other', data: record(6, 'session') }),
    ];
    expect(extractSessionRecords(lines.join('\n'))).toEqual([record(5, 'session')]);
  });

  it('appends, prunes by retention and reads the ledger', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pm-ledger-'));
    const file = path.join(dir, 'nested', 'ledger.jsonl');
    const now = 100 * DAY;
    await appendLedger(file, record(now - 40 * DAY), now);
    await appendLedger(file, record(now - DAY), now);
    await writeFile(file, `${await readFile(file, 'utf8')}garbage\n`);
    await appendLedger(file, record(now), now, true);
    expect((await readLedger(file, 0)).map((r) => r.at)).toEqual([now - DAY, now]);
    expect((await readFile(file, 'utf8')).includes('garbage')).toBe(false);
  });

  // 清理是「读出 → 写临时文件 → rename」：读出之后、rename 之前落盘的并发追加会被整文件覆盖掉
  it('清理与并发追加交错时不丢记录', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pm-race-'));
    const file = path.join(dir, 'ledger.jsonl');
    const now = 100 * DAY;
    await appendLedger(file, record(now - DAY), now);
    let concurrent: Promise<void> | undefined;
    vi.mocked(readFile).mockImplementationOnce((async (...args: Parameters<typeof readFile>) => {
      const text = await actualFs.readFile(...args);
      // 清理刚读出旧内容时到达一条追加，再给它留出落盘时间
      concurrent = appendLedger(file, record(now - 1), now);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return text;
    }) as typeof readFile);
    await appendLedger(file, record(now - 2), now, true);
    await concurrent;
    expect((await readLedger(file, 0)).map((r) => r.at).sort((a, b) => a - b)).toEqual([
      now - DAY,
      now - 2,
      now - 1,
    ]);
  });

  it('collects session and ledger records within range, newest first', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pm-sessions-'));
    const now = 100 * DAY;
    const entry = (at: number) =>
      JSON.stringify({
        type: 'custom',
        customType: 'enso-privacy-mask',
        data: record(at, 'session'),
      });
    await writeFile(
      path.join(dir, 'a.jsonl'),
      `${entry(now - 2 * DAY)}\n${entry(now - 10 * DAY)}\n`
    );
    await writeFile(path.join(dir, 'b.txt'), entry(now));
    const ledger = path.join(dir, 'ledger.jsonl');
    await appendLedger(ledger, record(now - DAY), now);
    const out = await collectRecords({ sessionDir: dir, ledgerFile: ledger, since: now - 7 * DAY });
    expect(out.map((r) => [r.at, r.source])).toEqual([
      [now - DAY, 'aux'],
      [now - 2 * DAY, 'session'],
    ]);
  });
});
