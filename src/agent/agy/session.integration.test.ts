import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { probeAgyAuth } from './probe';
import { type AgySession, openAgySession } from './session';

const fakePath = fileURLToPath(new URL('./fixtures/fakeAgy.mjs', import.meta.url));
const preamble = 'You are a coding assistant running inside pi';
const openSessions: AgySession[] = [];
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agy-session-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(openSessions.splice(0).map((session) => session.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('agy session against the fake CLI', () => {
  it('streams text, thinking and a native tool, answers permission by policy, then cancels', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'a.ts');
    const log = path.join(dir, 'log');
    writeFileSync(file, 'file body');
    const session = await openAgySession({
      command: process.execPath,
      args: [fakePath],
      cwd: dir,
      env: { ...process.env, FAKE_AGY_LOG: log, FAKE_AGY_READ: file },
      clientVersion: '0.3.14',
      readRoots: [dir],
      timeoutMs: 8_000,
    });
    openSessions.push(session);
    const events: unknown[] = [];
    const asked: string[] = [];
    const result = await session.turn({
      messages: [
        { role: 'system', content: `${preamble}\n<skills>secret</skills>` },
        { role: 'custom', content: 'injected custom message' },
        { role: 'user', content: 'fix it' },
      ],
      planMode: false,
      approvalMode: 'full',
      workspaceRoot: dir,
      modelId: 'default',
      thinkingLevel: 'off',
      modelLabel: 'default',
      ask: async (request) => {
        asked.push(request.toolCall.toolCallId);
        return 'allow';
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.text).toBe('Hello from agy');
    expect(result.thinking).toBe('thinking');
    expect(result.usage).toMatchObject({ input: 5, cacheRead: 2, output: 4 });
    expect(events).toEqual(
      expect.arrayContaining([
        { type: 'text', delta: 'Hello from agy' },
        { type: 'thinking', delta: 'thinking' },
        expect.objectContaining({
          type: 'tool',
          id: 'read-1',
          name: 'read_file',
          status: 'completed',
        }),
      ])
    );
    expect(asked).toEqual([]);
    const transcript = readFileSync(log, 'utf8');
    expect(transcript).not.toContain(preamble);
    expect(transcript).not.toContain('<skills>');
    expect(transcript).not.toContain('injected custom message');
    expect(transcript).toContain('fix it');
    expect(transcript).toContain('"optionId":"allow"');
    expect(transcript).toContain('file body');

    const controller = new AbortController();
    const cancelled = await session.turn({
      messages: [{ role: 'user', content: 'stop' }],
      planMode: false,
      approvalMode: 'supervised',
      workspaceRoot: dir,
      modelId: 'default',
      thinkingLevel: 'high',
      modelLabel: 'default',
      signal: controller.signal,
      ask: () => {
        controller.abort();
        return Promise.resolve('cancel');
      },
      onEvent: () => {},
    });
    expect(cancelled.stopReason).toBe('aborted');
    expect(readFileSync(log, 'utf8')).toContain('"method":"session/cancel"');
  });

  it('sets the thinking level once, not on every turn', async () => {
    const dir = tempDir();
    const log = path.join(dir, 'log');
    const session = await openAgySession({
      command: process.execPath,
      args: [fakePath],
      cwd: dir,
      env: { ...process.env, FAKE_AGY_LOG: log },
      clientVersion: '0.3.14',
      readRoots: [dir],
      timeoutMs: 8_000,
    });
    openSessions.push(session);
    const turn = (text: string) =>
      session.turn({
        messages: [{ role: 'user', content: text }],
        planMode: false,
        approvalMode: 'full',
        workspaceRoot: dir,
        modelId: 'default',
        thinkingLevel: 'off',
        modelLabel: 'default',
        ask: async () => 'allow',
      });
    await turn('one');
    await turn('two');
    const sets = readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line.includes('"method":"session/set_config_option"'));
    expect(sets).toHaveLength(1);
    expect(sets[0]).toContain('"value":"low"');
  });

  it('resumes a saved session id and reports signed-out without authenticate', async () => {
    const dir = tempDir();
    const log = path.join(dir, 'log');
    const session = await openAgySession({
      command: process.execPath,
      args: [fakePath],
      cwd: dir,
      env: { ...process.env, FAKE_AGY_LOG: log },
      clientVersion: '0.3.14',
      readRoots: [dir],
      resumeSessionId: 'saved-session',
      timeoutMs: 8_000,
    });
    openSessions.push(session);
    expect(session.resumed).toBe(true);
    expect(session.sessionId()).toBe('saved-session');
    expect(readFileSync(log, 'utf8')).toContain('"method":"session/resume"');

    const status = await probeAgyAuth({
      command: process.execPath,
      args: [fakePath],
      env: { ...process.env, FAKE_AGY_SIGNED_OUT: '1' },
      clientVersion: '0.3.14',
      timeoutMs: 8_000,
    });
    expect(status).toEqual({ status: 'signed-out', version: '1.5.18' });
  });
});
