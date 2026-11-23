import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAppLogLines } from './appLog';
import { installConsoleLog, RotatingLogFile } from './appLogFile';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function temp(): string {
  dir = mkdtempSync(path.join(tmpdir(), 'enso-applog-'));
  return dir;
}

describe('RotatingLogFile', () => {
  it('超过单文件上限滚动，只保留 keep 份', () => {
    const file = path.join(temp(), 'logs', 'main.log');
    const log = new RotatingLogFile(file, { maxBytes: 100, keep: 2 });
    for (let i = 0; i < 50; i++) log.append(`${String(i).padStart(2, '0')}${'x'.repeat(18)}\n`);
    const names = readdirSync(path.dirname(file)).sort();
    expect(names).toEqual(['main.1.log', 'main.2.log', 'main.log']);
    for (const name of names) {
      expect(statSync(path.join(path.dirname(file), name)).size).toBeLessThanOrEqual(100);
    }
    expect(readFileSync(file, 'utf8')).toContain('49');
  });
});

describe('installConsoleLog', () => {
  it('console 输出写成脱敏的结构化行，并按前缀区分来源', () => {
    const file = path.join(temp(), 'agent.log');
    const sink = { log() {}, info() {}, warn() {}, error() {} } as unknown as Console;
    const uninstall = installConsoleLog(file, 'agent', { console: sink });
    sink.error('[mcp] connect failed', new Error('Bearer abcdefghijk'));
    sink.warn('slow');
    sink.log('hello');
    uninstall();
    sink.error('after uninstall');
    const entries = parseAppLogLines(readFileSync(file, 'utf8'));
    expect(entries.map((e) => [e.level, e.source])).toEqual([
      ['error', 'mcp'],
      ['warn', 'agent'],
      ['info', 'agent'],
    ]);
    expect(entries[0].detail).toContain('Error: Bearer ***');
    expect(entries[0].detail).not.toContain('abcdefghijk');
  });
});
