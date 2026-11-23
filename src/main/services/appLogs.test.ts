import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { formatAppLogLine } from '@shared/appLog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectErrorSummary, exportLogs } from './appLogs';
import { extractZip } from './extensionPlugins/zip';

const NOW = Date.parse('2025-03-02T12:00:00Z');
const hoursAgo = (h: number) => NOW - h * 3600_000;
let root = '';

function write(rel: string, text: string, mtime = NOW): void {
  const file = path.join(root, 'data', rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  utimesSync(file, mtime / 1000, mtime / 1000);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'enso-applogs-'));
  write(
    'agent/logs/main.log',
    formatAppLogLine({ time: hoursAgo(30), level: 'error', source: 'main', text: 'old failure' }) +
      formatAppLogLine({ time: hoursAgo(2), level: 'info', source: 'main', text: 'booted' }) +
      formatAppLogLine({
        time: hoursAgo(1),
        level: 'error',
        source: 'main',
        text: '[bots] send failed',
      })
  );
  write(
    'agent/logs/agent.log',
    formatAppLogLine({
      time: hoursAgo(1.5),
      level: 'error',
      source: 'mcp',
      text: '[mcp] connect failed',
    })
  );
  write(
    'extension-plugins/logs/demo.x.log',
    `${new Date(hoursAgo(3)).toISOString()} [error] plugin crashed Authorization: Bearer abcdefghijklmn\n`
  );
  write(
    'agent/worker-exits.log',
    `[${new Date(hoursAgo(0.5)).toISOString()}] worker exited code=1 password=hunter2\nstack line\n`
  );
  write('agent/compaction.log', 'stale only\n', hoursAgo(48));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('collectErrorSummary', () => {
  it('汇总各来源的 error，倒序且已脱敏', async () => {
    const entries = await collectErrorSummary(path.join(root, 'data'), {
      minLevel: 'error',
      limit: 10,
    });
    expect(entries.map((e) => [e.source, e.message])).toEqual([
      ['agent', 'worker exited code=1 password=***'],
      ['main', '[bots] send failed'],
      ['mcp', '[mcp] connect failed'],
      ['plugin', '[demo.x] plugin crashed Authorization: *** ***'],
      ['main', 'old failure'],
    ]);
    expect(entries[0].detail).toContain('stack line');
  });

  it('目录不存在时返回空列表', async () => {
    await expect(
      collectErrorSummary(path.join(root, 'missing'), { minLevel: 'warn', limit: 10 })
    ).resolves.toEqual([]);
  });
});

describe('exportLogs', () => {
  it('生成 zip，只含时间窗内的脱敏内容', async () => {
    const target = path.join(root, 'out', 'logs.zip');
    const result = await exportLogs(path.join(root, 'data'), target, { hours: 24, now: NOW });
    expect(result.files).toBeGreaterThan(0);

    const dest = path.join(root, 'unzipped');
    mkdirSync(dest);
    await extractZip(target, dest);
    const read = (rel: string) => readFileSync(path.join(dest, rel), 'utf8');

    const main = read('agent/logs/main.log');
    expect(main).toContain('send failed');
    expect(main).toContain('booted');
    expect(main).not.toContain('old failure');
    const plugin = read('extension-plugins/logs/demo.x.log');
    expect(plugin).toContain('plugin crashed');
    expect(plugin).not.toContain('abcdefghijklmn');
    const exits = read('agent/worker-exits.log');
    expect(exits).toContain('stack line');
    expect(exits).not.toContain('hunter2');
    expect(() => read('agent/compaction.log')).toThrow();
    expect(JSON.parse(read('export-info.json'))).toMatchObject({ hours: 24 });
  });
});
