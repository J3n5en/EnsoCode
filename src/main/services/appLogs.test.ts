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
    [
      `${new Date(hoursAgo(3)).toISOString()} [error] plugin crashed Authorization: Bearer abcdefghijklmn`,
      `${new Date(hoursAgo(2.6)).toISOString()} [warn] Cookie: a=1; sid=EXPORT_SID_SECRET; csrftoken=EXPORT_CSRF`,
      `${new Date(hoursAgo(2.5)).toISOString()} [warn] at /Users/alice/app.ts alice@example.com 13812345678 {\\"api_key\\":\\"EXPORT_ESC_KEY\\"}`,
      '',
    ].join('\n')
  );
  write(
    'agent/worker-exits.log',
    [
      `[${new Date(hoursAgo(0.9)).toISOString()}] [graceful-restart] restart: 到安全点，恢复清单 1 个会话`,
      `[${new Date(hoursAgo(0.8)).toISOString()}] [graceful-restart] restart: 会话 12345678 回复：结果：已完成`,
      `[${new Date(hoursAgo(0.7)).toISOString()}] exit pid=100 code=0 (graceful restart)`,
      `[${new Date(hoursAgo(0.6)).toISOString()}] [graceful-restart] quit: worker 等安全点 5000ms 超时`,
      `[${new Date(hoursAgo(0.5)).toISOString()}] exit pid=101 code=1 password=hunter2`,
      'stack line',
      '',
    ].join('\n')
  );
  write('agent/compaction.log', 'stale only\n', hoursAgo(48));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('collectErrorSummary', () => {
  it('汇总各来源的 error，不把正常优雅重启/退出算作错误，倒序且已脱敏', async () => {
    const entries = await collectErrorSummary(path.join(root, 'data'), {
      minLevel: 'error',
      limit: 10,
    });
    expect(entries.map((e) => [e.source, e.message])).toEqual([
      ['agent', 'exit pid=101 code=1 password=***'],
      ['main', '[bots] send failed'],
      ['mcp', '[mcp] connect failed'],
      ['plugin', '[demo.x] plugin crashed Authorization: *** ***'],
      ['main', 'old failure'],
    ]);
    expect(entries[0].detail).toContain('stack line');
  });

  it('warn 模式下包含优雅重启超时，仍不包含正常重启与 code=0 退出', async () => {
    const entries = await collectErrorSummary(path.join(root, 'data'), {
      minLevel: 'warn',
      limit: 20,
    });
    const messages = entries.map((e) => e.message);
    expect(messages.some((m) => m.includes('等安全点 5000ms 超时'))).toBe(true);
    expect(messages.some((m) => m.includes('到安全点'))).toBe(false);
    expect(messages.some((m) => m.includes('结果：已完成'))).toBe(false);
    expect(messages.some((m) => m.includes('code=0'))).toBe(false);
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
    expect(plugin).not.toContain('EXPORT_SID_SECRET');
    expect(plugin).not.toContain('EXPORT_CSRF');
    expect(plugin).not.toContain('alice');
    expect(plugin).not.toContain('13812345678');
    expect(plugin).not.toContain('EXPORT_ESC_KEY');
    expect(plugin).toContain('/Users/<user>/app.ts');
    const exits = read('agent/worker-exits.log');
    expect(exits).toContain('stack line');
    expect(exits).not.toContain('hunter2');
    expect(() => read('agent/compaction.log')).toThrow();
    expect(JSON.parse(read('export-info.json'))).toMatchObject({ hours: 24 });
  });
});
