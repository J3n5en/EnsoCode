import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeAgyAuth } from './probe';
import { type AgySession, type AgyTurnInput, openAgySession } from './session';

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

  it('offers the Enso Host MCP on agy 1.5.18, allows its own tool unasked, and revokes on close', async () => {
    const dir = tempDir();
    const log = path.join(dir, 'log');
    let revoked = 0;
    const server = {
      type: 'http' as const,
      name: 'enso',
      url: 'http://127.0.0.1:1/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer t' }],
    };
    const session = await openAgySession({
      command: process.execPath,
      args: [fakePath],
      cwd: dir,
      env: { ...process.env, FAKE_AGY_LOG: log, FAKE_AGY_MCP_PERMISSION: 'todo' },
      clientVersion: '0.3.14',
      readRoots: [dir],
      timeoutMs: 8_000,
      hostMcp: { tools: ['todo'], issue: async () => ({ server, revoke: () => (revoked += 1) }) },
    });
    const asked: string[] = [];
    await session.turn({
      messages: [{ role: 'user', content: 'plan' }],
      planMode: false,
      approvalMode: 'supervised',
      workspaceRoot: dir,
      modelId: 'default',
      thinkingLevel: 'off',
      modelLabel: 'default',
      ask: async (request) => {
        asked.push(request.toolCall.toolCallId);
        return 'deny';
      },
    });
    expect(session.ensoTools).toEqual(['todo']);
    await session.turn({
      messages: [{ role: 'user', content: 'again' }],
      planMode: false,
      approvalMode: 'supervised',
      workspaceRoot: dir,
      modelId: 'default',
      thinkingLevel: 'off',
      modelLabel: 'default',
      ask: async () => 'deny',
    });
    const prompts = readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line.includes('"method":"session/prompt"'));
    expect(prompts[0]).toContain('mcp_enso_todo');
    expect(prompts.at(-1)).not.toContain('mcp_enso_todo');
    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    const opened = lines.find((line) => line.includes('"method":"session/new"'));
    expect(JSON.parse(opened ?? '{}').params.mcpServers).toEqual([server]);
    expect(asked).toEqual([]);
    expect(readFileSync(log, 'utf8')).toContain('"optionId":"allow"');
    await session.close();
    expect(revoked).toBe(1);
  });

  it('offers no MCP server to an agy that cannot take one', async () => {
    const dir = tempDir();
    const log = path.join(dir, 'log');
    let issued = 0;
    const session = await openAgySession({
      command: process.execPath,
      args: [fakePath],
      cwd: dir,
      env: { ...process.env, FAKE_AGY_LOG: log, FAKE_AGY_VERSION: '1.5.10' },
      clientVersion: '0.3.14',
      readRoots: [dir],
      timeoutMs: 8_000,
      hostMcp: {
        tools: ['todo'],
        issue: async () => {
          issued += 1;
          throw new Error('should not issue');
        },
      },
    });
    openSessions.push(session);
    const opened = readFileSync(log, 'utf8')
      .split('\n')
      .find((line) => line.includes('"method":"session/new"'));
    expect(JSON.parse(opened ?? '{}').params.mcpServers).toEqual([]);
    expect(issued).toBe(0);
    expect(session.ensoTools).toEqual([]);
  });
});

describe('agy session mid-turn steer and background work', () => {
  async function open(env: Record<string, string>) {
    const dir = tempDir();
    const log = path.join(dir, 'log');
    const session = await openAgySession({
      command: process.execPath,
      args: [fakePath],
      cwd: dir,
      env: { ...process.env, FAKE_AGY_LOG: log, ...env },
      clientVersion: '0.3.14',
      readRoots: [dir],
      timeoutMs: 8_000,
    });
    openSessions.push(session);
    const prompts = () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line.includes('"method":"session/prompt"'))
        .map((line) => JSON.parse(line).params.prompt as Array<{ text?: string }>);
    const logged = () => readFileSync(log, 'utf8');
    return { session, dir, prompts, logged };
  }

  const input = (dir: string, messages: AgyTurnInput['messages'], extra = {}): AgyTurnInput => ({
    messages,
    planMode: false,
    approvalMode: 'full',
    workspaceRoot: dir,
    modelId: 'default',
    thinkingLevel: 'high',
    modelLabel: 'default',
    ask: async () => 'allow',
    ...extra,
  });

  it('sends a steer as a raw second prompt, splits the answers at the usage_update, never resends it', async () => {
    const { session, dir, prompts } = await open({ FAKE_AGY_SCRIPT: 'steer' });
    const steer = { role: 'user', content: [{ type: 'text', text: 'Stop. Reply steered' }] };
    const firstEvents: unknown[] = [];
    let steered = false;
    const first = await session.turn(
      input(dir, [{ role: 'user', content: 'Tell a story' }], {
        onEvent: (event: unknown) => {
          firstEvents.push(event);
          if (!steered) steered = session.steer([steer]);
        },
      })
    );
    expect(steered).toBe(true);
    expect(first.stopReason).toBe('stop');
    expect(first.text).toBe('Once upon a time.');
    expect(first.usage.totalTokens).toBe(0);

    const secondEvents: unknown[] = [];
    const second = await session.turn(
      input(
        dir,
        [
          { role: 'user', content: 'Tell a story' },
          { role: 'assistant', content: [{ type: 'text', text: 'Once upon a time.' }] },
          steer,
        ],
        { onEvent: (event: unknown) => secondEvents.push(event) }
      )
    );
    expect(second.text).toBe('steered');
    expect(second.usage).toMatchObject({ input: 50, output: 40, totalTokens: 90 });
    expect(secondEvents).toEqual([{ type: 'text', delta: 'steered' }]);
    const sent = prompts();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual([{ type: 'text', text: 'Stop. Reply steered' }]);
    expect(session.phase().phase).toBe('session-ready');
  });

  it('does not steer when no turn is running', async () => {
    const { session } = await open({ FAKE_AGY_SCRIPT: 'steer' });
    expect(session.steer([{ role: 'user', content: 'late' }])).toBe(false);
  });

  it('keeps the turn open past end_turn while a background command runs, and takes its follow-up reply', async () => {
    const { session, dir } = await open({ FAKE_AGY_SCRIPT: 'background' });
    const statuses: string[] = [];
    const result = await session.turn(
      input(dir, [{ role: 'user', content: 'wait for it' }], {
        onEvent: (event: { type: string; status?: string }) => {
          if (event.type === 'tool' && event.status) statuses.push(event.status);
        },
      })
    );
    expect(result.text).toBe('Starting.It printed done.');
    expect(statuses).toEqual(['in_progress', 'completed']);
    expect(result.tools[0]).toMatchObject({ id: 'bg-1', status: 'completed', output: 'done\n' });
  }, 15_000);

  it('ends at end_turn when the running command is a daemon', async () => {
    const { session, dir } = await open({ FAKE_AGY_SCRIPT: 'background', FAKE_AGY_DAEMON: '1' });
    const result = await session.turn(input(dir, [{ role: 'user', content: 'serve' }]));
    expect(result.text).toBe('Starting.');
    expect(result.tools[0]).toMatchObject({ id: 'bg-1', status: 'in_progress' });
  });

  it('sends session/cancel for a held turn only when the user stops it', async () => {
    const { session, dir, logged } = await open({
      FAKE_AGY_SCRIPT: 'background',
      FAKE_AGY_BACKGROUND_MS: '5000',
    });
    const controller = new AbortController();
    const pending = session.turn(
      input(dir, [{ role: 'user', content: 'wait' }], { signal: controller.signal })
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(logged()).not.toContain('"method":"session/cancel"');
    const started = Date.now();
    controller.abort();
    const result = await pending;
    expect(result.stopReason).toBe('aborted');
    expect(Date.now() - started).toBeLessThan(1_000);
    await vi.waitFor(() => expect(logged()).toContain('"method":"session/cancel"'));
  });
});
