import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REMINDERS_FILE } from '@shared/reminders';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fork = vi.hoisted(() => ({
  userData: '',
  children: [] as Array<{ emit(event: string, ...args: unknown[]): void }>,
}));
vi.mock('../../agent/index?modulePath', () => ({ default: '/tmp/agent.js' }));
vi.mock('electron', () => ({
  app: {
    getPath: () => fork.userData,
    getAppPath: () => fork.userData,
    isPackaged: false,
    getVersion: () => '0.0.0',
    on: () => {},
  },
  notification: { isSupported: () => false },
  clipboard: { writeText: () => {} },
  shell: { openExternal: () => Promise.resolve() },
  utilityProcess: {
    fork: () => {
      const handlers = new Map<string, (...args: unknown[]) => void>();
      const child = {
        postMessage: () => {},
        once: (event: string, handler: (...args: unknown[]) => void) =>
          handlers.set(event, handler),
        on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler),
        kill() {},
        emit: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args),
      };
      fork.children.push(child);
      return child;
    },
  },
}));
vi.mock('./processExit', () => ({ killAndWaitExit: vi.fn(async () => {}) }));

import { startAgentWorker, stopAgentWorker } from './agentHost';

const NOW = Date.UTC(2026, 10, 24, 4, 0, 0);

function writeReminders(dueAts: number[]): void {
  const dir = path.join(fork.userData, 'agent', 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, REMINDERS_FILE),
    JSON.stringify({
      version: 1,
      reminders: dueAts.map((dueAt, index) => ({
        id: `r0000000${index}`,
        sessionId: `session-${index}`,
        dueAt,
        createdAt: NOW - 60_000,
        prompt: 'check CI',
        ifIdle: true,
        chain: 1,
      })),
      chains: {},
    })
  );
}

function crashWorker(): void {
  const child = fork.children.at(-1)!;
  child.emit('exit', 1);
}

beforeEach(() => {
  fork.userData = mkdtempSync(path.join(tmpdir(), 'enso-reminder-revive-'));
  fork.children.length = 0;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(NOW);
  startAgentWorker();
  fork.children[0].emit('spawn');
});

afterEach(() => {
  stopAgentWorker();
  vi.useRealTimers();
  rmSync(fork.userData, { recursive: true, force: true });
});

it('worker 崩溃且有没到点的提醒：到最早的到点时间重新拉起 worker，由它接着触发', async () => {
  writeReminders([NOW + 10 * 60_000, NOW + 3 * 60_000]);
  crashWorker();
  expect(fork.children).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(3 * 60_000 - 1);
  expect(fork.children).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(fork.children).toHaveLength(2);
});

it('worker 崩溃时提醒已过点：稍后拉起一次，不在崩溃当下立刻重启', async () => {
  writeReminders([NOW - 60_000]);
  crashWorker();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(fork.children).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fork.children).toHaveLength(2);
});

it('worker 崩溃但没有提醒：不主动拉起，照旧等下一条命令', async () => {
  crashWorker();
  await vi.advanceTimersByTimeAsync(24 * 3_600_000);
  expect(fork.children).toHaveLength(1);
});

it('等着拉起期间已被别的命令拉起：到点不再多起一个', async () => {
  writeReminders([NOW + 60_000]);
  crashWorker();
  startAgentWorker();
  expect(fork.children).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(2 * 60_000);
  expect(fork.children).toHaveLength(2);
});
