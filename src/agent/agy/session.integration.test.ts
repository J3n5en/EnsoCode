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
    // 上下文占用取 usage_update.used，不取 PromptResponse.usage 的整轮累加
    expect(result.usage).toEqual({
      input: 7,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 7,
    });
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

describe('agy session carries the Enso system append', () => {
  const APPEND = '# Rich visualizations\n- reply with an ```html-viz fenced block';

  async function open(env: Record<string, string>, extra: { resumeSessionId?: string } = {}) {
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
      systemAppend: APPEND,
      ...extra,
    });
    openSessions.push(session);
    const lines = () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> });
    const opened = (method: string) => lines().filter((line) => line.method === method);
    // 假 CLI 对 session/prompt 记两行（收到时、开始回答时）：相邻重复只算一次
    const prompts = () =>
      opened('session/prompt')
        .map((line) =>
          ((line.params?.prompt ?? []) as Array<{ text?: string }>)
            .map((block) => block.text ?? '')
            .join('\n')
        )
        .filter((text, index, all) => index === 0 || all[index - 1] !== text);
    const turn = (text: string, systemAppend: string | undefined = APPEND) =>
      session.turn({
        messages: [{ role: 'user', content: text }],
        planMode: false,
        approvalMode: 'full',
        workspaceRoot: dir,
        modelId: 'default',
        thinkingLevel: 'off',
        modelLabel: 'default',
        ask: async () => 'allow',
        systemAppend,
      });
    return { session, opened, prompts, turn };
  }

  const metaOf = (params: Record<string, unknown> | undefined) => params?._meta;
  const appendMeta = { antigravity: { systemPrompt: { append: APPEND } } };

  it('sends it as session/new _meta when agy can append, and not again in the prompt', async () => {
    const { opened, prompts, turn } = await open({});
    expect(metaOf(opened('session/new')[0]?.params)).toEqual(appendMeta);
    await turn('one');
    await turn('two');
    expect(prompts()[0]).toContain('<enso_instructions>');
    for (const prompt of prompts()) expect(prompt).not.toContain('html-viz');
  });

  it('sends it on session/resume', async () => {
    const { session, opened } = await open({}, { resumeSessionId: 'saved' });
    expect(session.resumed).toBe(true);
    expect(metaOf(opened('session/resume')[0]?.params)).toEqual(appendMeta);
    expect(opened('session/new')).toHaveLength(0);
  });

  it('sends it on the session/new fallback when resume fails', async () => {
    const { session, opened } = await open(
      { FAKE_AGY_RESUME_FAIL: '1' },
      { resumeSessionId: 'gone' }
    );
    expect(session.resumed).toBe(false);
    expect(opened('session/resume')).toHaveLength(1);
    expect(metaOf(opened('session/new')[0]?.params)).toEqual(appendMeta);
  });

  it('falls back to the first prompt instructions when agy cannot append', async () => {
    const { opened, prompts, turn } = await open({ FAKE_AGY_NO_APPEND: '1' });
    expect(metaOf(opened('session/new')[0]?.params)).toBeUndefined();
    await turn('one');
    await turn('two');
    const [first, second] = prompts();
    const start = first?.indexOf('<enso_instructions>') ?? -1;
    expect(start).toBeGreaterThanOrEqual(0);
    expect(first?.indexOf('html-viz')).toBeGreaterThan(start);
    expect(first?.indexOf('html-viz')).toBeLessThan(first?.indexOf('</enso_instructions>') ?? -1);
    expect(second).not.toContain('html-viz');
    expect(second).not.toContain('<enso_instructions>');
  });

  it('sends no _meta when there is nothing to append', async () => {
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
      systemAppend: '',
    });
    openSessions.push(session);
    const opened = readFileSync(log, 'utf8')
      .split('\n')
      .find((line) => line.includes('"method":"session/new"'));
    expect(JSON.parse(opened ?? '{}').params._meta).toBeUndefined();
  });

  it('resends a changed append once inside the next prompt instructions, without reopening', async () => {
    const { opened, prompts, turn } = await open({});
    await turn('one');
    const changed = `${APPEND}\n\n<preset_tail>\nnew tail\n</preset_tail>`;
    await turn('two', changed);
    await turn('three', changed);
    const [, second, third] = prompts();
    expect(second).toContain('<enso_instructions>');
    expect(second).toContain('new tail');
    expect(third).not.toContain('new tail');
    expect(opened('session/new')).toHaveLength(1);
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
    // 被插话的段没有 PromptResponse.usage，但以 usage_update(10) 收口
    expect(first.usage).toMatchObject({ input: 10, output: 0, totalTokens: 10 });

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
    expect(second.usage).toMatchObject({ input: 12, cacheRead: 0, output: 40, totalTokens: 12 });
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

  it('reports the context agy is at, not the sum of its model calls in the turn', async () => {
    const { session, dir } = await open({
      FAKE_AGY_INPUT_TOKENS: '5357142',
      FAKE_AGY_CONTEXT_USED: '30000',
    });
    const result = await session.turn(input(dir, [{ role: 'user', content: 'big task' }]));
    expect(result.usage).toEqual({
      input: 30_000,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30_000,
    });
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
