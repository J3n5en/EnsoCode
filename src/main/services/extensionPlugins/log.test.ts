import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOG_RATE_PER_SECOND, MAX_LOG_BYTES, PluginLogger } from './log';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-log-'));
  temps.push(dir);
  return dir;
};

describe('PluginLogger', () => {
  it('多次追加先留在内存，读取时一次写入并保留轮转', async () => {
    const root = temp();
    const logger = new PluginLogger(root, () => 1_700_000_000_000);
    logger.append('example.demo', 'info', 'a');
    logger.append('example.demo', 'warn', 'b');
    const path = join(root, 'logs', 'example.demo.log');
    expect(existsSync(path)).toBe(false);
    expect(await logger.read('example.demo')).toBe(
      '2023-11-14T22:13:20.000Z [info] a\n2023-11-14T22:13:20.000Z [warn] b\n'
    );
    expect(readFileSync(path, 'utf8')).toContain('[warn] b');

    logger.append('example.demo', 'info', 'x'.repeat(MAX_LOG_BYTES));
    logger.read('example.demo');
    logger.append('example.demo', 'info', 'after-rotate');
    expect(await logger.read('example.demo')).toContain('after-rotate');
    expect(await logger.read('example.demo')).not.toContain('[warn] b');
    expect(statSync(`${path}.1`).size).toBeGreaterThan(MAX_LOG_BYTES);
  });

  it('超过每秒上限时丢弃，并只记一条已丢弃行数', async () => {
    const root = temp();
    let now = 1_700_000_000_000;
    const logger = new PluginLogger(root, () => now);
    for (let i = 0; i < LOG_RATE_PER_SECOND + 40; i++)
      logger.append('example.demo', 'info', `m${i}`);
    const text = await logger.read('example.demo');
    const kept = text.split('\n').filter((line) => line.includes('[info] m'));
    expect(kept).toHaveLength(LOG_RATE_PER_SECOND);
    expect(text).toContain(`[warn] 已丢弃 40 行`);
    expect(text).toContain('m0');
    expect(text).not.toContain(`m${LOG_RATE_PER_SECOND + 39}`);
    now += 1000;
    logger.append('example.demo', 'info', 'next-window');
    expect(await logger.read('example.demo')).toContain('next-window');
  });

  it('dispose 时按写入顺序把队列落盘', async () => {
    const root = temp();
    const logger = new PluginLogger(root, () => 1_700_000_000_000);
    logger.append('example.demo', 'info', 'a');
    logger.append('example.demo', 'warn', 'b');
    const path = join(root, 'logs', 'example.demo.log');
    expect(existsSync(path)).toBe(false);
    await logger.dispose();
    expect(readFileSync(path, 'utf8')).toBe(
      '2023-11-14T22:13:20.000Z [info] a\n2023-11-14T22:13:20.000Z [warn] b\n'
    );
  });
});
