import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AGENT_WORKER_CRASH_FILE, AGENT_WORKER_EXIT_LOG } from '@shared/agentWorkerExit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_WORKER_SERVICE_NAME,
  appendAgentWorkerExitLog,
  createOutputTail,
  isAgentWorkerGone,
  takeAgentWorkerCrash,
} from './agentWorkerExit';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'worker-exit-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const crash = { pid: 42, at: 1, origin: 'uncaughtException', message: 'boom' };

describe('takeAgentWorkerCrash', () => {
  it('读取本 pid 的记录后删除文件', () => {
    writeFileSync(path.join(dir, AGENT_WORKER_CRASH_FILE), JSON.stringify(crash));
    expect(takeAgentWorkerCrash(dir, 42)).toEqual(crash);
    expect(existsSync(path.join(dir, AGENT_WORKER_CRASH_FILE))).toBe(false);
  });

  it('pid 不符、坏 JSON、文件不存在都返回 null', () => {
    writeFileSync(path.join(dir, AGENT_WORKER_CRASH_FILE), JSON.stringify(crash));
    expect(takeAgentWorkerCrash(dir, 43)).toBeNull();
    writeFileSync(path.join(dir, AGENT_WORKER_CRASH_FILE), '{torn');
    expect(takeAgentWorkerCrash(dir, 42)).toBeNull();
    expect(takeAgentWorkerCrash(path.join(dir, 'missing'), 42)).toBeNull();
  });
});

describe('appendAgentWorkerExitLog', () => {
  it('追加写入，超过上限时从头开始', () => {
    appendAgentWorkerExitLog(dir, 'first', 100);
    appendAgentWorkerExitLog(dir, 'second', 100);
    const file = path.join(dir, AGENT_WORKER_EXIT_LOG);
    expect(readFileSync(file, 'utf8')).toMatch(/first[\s\S]*second/);
    appendAgentWorkerExitLog(dir, 'x'.repeat(80), 100);
    appendAgentWorkerExitLog(dir, 'third', 100);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('first');
    expect(text).toContain('third');
  });

  it('目录不存在时不抛错', () => {
    expect(() => appendAgentWorkerExitLog(path.join(dir, 'missing', 'deep'), 'x')).not.toThrow();
  });
});

describe('isAgentWorkerGone', () => {
  it('按 fork 的 serviceName 匹配 details.name；details.serviceName 是 Chromium 服务名', () => {
    const gone = { type: 'Utility', serviceName: 'node.mojom.NodeService' };
    expect(isAgentWorkerGone({ ...gone, name: AGENT_WORKER_SERVICE_NAME })).toBe(true);
    expect(isAgentWorkerGone({ ...gone, name: 'enso-plugin-host' })).toBe(false);
    expect(isAgentWorkerGone({ type: 'GPU', name: AGENT_WORKER_SERVICE_NAME })).toBe(false);
  });
});

describe('createOutputTail', () => {
  it('只保留最后 maxBytes 字节', () => {
    const tail = createOutputTail(8);
    expect(tail.text()).toBe('');
    tail.push(Buffer.from('abcdef'));
    tail.push(Buffer.from('ghij'));
    expect(tail.text()).toBe('cdefghij');
    tail.push(Buffer.from('0123456789'));
    expect(tail.text()).toBe('23456789');
  });
});
