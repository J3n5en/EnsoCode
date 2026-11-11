import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../..');
const bundle = path.join(root, 'out/server/index.js');

interface Stub {
  url: string;
  requests: string[];
  hold: boolean;
  close: () => Promise<void>;
}

function sse(events: unknown[]): string {
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
}

function textEvents(text: string): unknown[] {
  const base = {
    id: 'chatcmpl_stub',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'stub-model',
  };
  return [
    {
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    },
  ];
}

function goalEvents(): unknown[] {
  const base = {
    id: 'chatcmpl_goal',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'stub-model',
  };
  const args = JSON.stringify({ summary: 'shipped the stub' });
  return [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            content: 'Done.',
            tool_calls: [
              {
                index: 0,
                id: 'call_goal',
                type: 'function',
                function: { name: 'goal_complete', arguments: args },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    },
  ];
}

async function startStub(): Promise<Stub> {
  const requests: string[] = [];
  const stub: Stub = {
    url: '',
    requests,
    hold: false,
    close: async () => undefined,
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push(`${req.method} ${req.url} ${body.slice(0, 400)}`);
      if (stub.hold) return;
      const followUp = body.includes('Goal marked') || body.includes('call_goal');
      const goal = body.includes('ship the stub') && !followUp;
      writeCompletion(res, goal ? goalEvents() : textEvents('hello from stub'));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('stub failed to listen');
  stub.url = `http://127.0.0.1:${address.port}/v1`;
  stub.close = () =>
    new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return stub;
}

function writeCompletion(res: ServerResponse, events: unknown[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.end(sse(events));
}

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  pid: number;
}> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, [bundle, 'run', ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!child.pid) {
      reject(new Error('failed to spawn enso-server'));
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) =>
      resolve({ code, signal, stdout, stderr, pid: child.pid ?? 0 })
    );
  });
}

// 需要先整包构建 out/server，不进默认 pnpm test；用 pnpm test:e2e:server 跑
describe.runIf(process.env.ENSO_RUN_E2E === '1').sequential('enso-server run', () => {
  let stub: Stub;
  const keep: string[] = [];

  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'vite', 'build', '-c', 'vite.server.config.ts'], {
      cwd: root,
      stdio: 'inherit',
      timeout: 180_000,
    });
    stub = await startStub();
  }, 180_000);

  afterAll(async () => {
    await stub?.close();
    for (const dir of keep) rmSync(dir, { recursive: true, force: true });
  });

  function workspace(): { data: string; work: string; usage: string } {
    const data = mkdtempSync(path.join(tmpdir(), 'enso-run-e2e-'));
    keep.push(data);
    const work = path.join(data, 'work');
    mkdirSync(work);
    return { data, work, usage: path.join(data, 'usage.jsonl') };
  }

  const providerArgs = () => [
    '--provider',
    'stub',
    '--model',
    'stub-model',
    '--api',
    'openai-completions',
    '--api-key',
    'test-key',
    '--base-url',
    stub.url,
  ];

  it('rejects a missing prompt on stderr and leaves stdout empty', async () => {
    const result = await runCli([], {});
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--prompt');
  });

  it('prints json, a usage log, and keeps diagnostics off stdout', async () => {
    const dir = workspace();
    const result = await runCli(
      [
        '--prompt',
        'Say hello',
        '--cwd',
        dir.work,
        '--data-dir',
        dir.data,
        '--output-format',
        'json',
        '--usage-log',
        dir.usage,
        '--timeout-ms',
        '60000',
        ...providerArgs(),
      ],
      {}
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('[enso-server]');
    expect(result.stdout).not.toContain('[spawn]');
    const parsed = JSON.parse(result.stdout) as {
      status: string;
      sessionId: string;
      finalMessage: string;
      turns: number;
      usage: { input: number; output: number };
    };
    expect(parsed).toMatchObject({
      status: 'success',
      exitReason: 'finished',
      finalMessage: 'hello from stub',
      turns: 1,
    });
    expect(parsed.sessionId).toBeTruthy();
    expect(parsed.usage.output).toBeGreaterThan(0);
    const lines = readFileSync(dir.usage, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines.at(-1)).toMatchObject({ type: 'summary', calls: lines.length - 1 });
    expect(lines[0]).toMatchObject({ type: 'call', provider: 'stub', model: 'stub-model' });
    expect(result.stderr).toContain(parsed.sessionId);
  });

  it('streams assistant deltas and a final result line', async () => {
    const dir = workspace();
    const result = await runCli(
      [
        '--prompt',
        'Say hello',
        '--cwd',
        dir.work,
        '--data-dir',
        dir.data,
        '--output-format',
        'stream-json',
        '--timeout-ms',
        '60000',
        ...providerArgs(),
      ],
      {}
    );
    expect(result.code, result.stderr).toBe(0);
    const events = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; text?: string });
    expect(
      events.some((event) => event.type === 'assistant.delta' && event.text?.includes('hello'))
    ).toBe(true);
    expect(events.at(-1)?.type).toBe('result');
  });

  it('exits 124 when the model endpoint never responds', async () => {
    const dir = workspace();
    stub.hold = true;
    try {
      const result = await runCli(
        [
          '--prompt',
          'wait',
          '--cwd',
          dir.work,
          '--data-dir',
          dir.data,
          '--output-format',
          'json',
          '--usage-log',
          dir.usage,
          '--timeout-ms',
          '1500',
          ...providerArgs(),
        ],
        {}
      );
      expect(result.code, result.stderr).toBe(124);
      const parsed = JSON.parse(result.stdout) as { status: string; exitReason: string };
      expect(parsed).toMatchObject({ status: 'timeout', exitReason: 'timeout' });
    } finally {
      stub.hold = false;
    }
  });

  it('exits 130 on SIGTERM and does not leave the worker running', async () => {
    const dir = workspace();
    stub.hold = true;
    const child = spawn(
      process.execPath,
      [
        bundle,
        'run',
        '--prompt',
        'wait',
        '--cwd',
        dir.work,
        '--data-dir',
        dir.data,
        '--output-format',
        'json',
        ...providerArgs(),
      ],
      { cwd: root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    try {
      const seen = stub.requests.length;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('model request did not start')), 30_000);
        const poll = setInterval(() => {
          if (stub.requests.length > seen) {
            clearInterval(poll);
            clearTimeout(timer);
            resolve();
          }
        }, 100);
        child.on('close', () => {
          clearInterval(poll);
          clearTimeout(timer);
          reject(new Error('process exited before the model request'));
        });
      });
      child.kill('SIGTERM');
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
      expect(code).toBe(130);
      expect(child.pid && existsSync(`/proc/${child.pid}`)).toBe(false);
    } finally {
      stub.hold = false;
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });

  it('stops a goal when the model calls goal_complete', async () => {
    const dir = workspace();
    const result = await runCli(
      [
        '--goal',
        'ship the stub',
        '--auto-turns',
        '4',
        '--cwd',
        dir.work,
        '--data-dir',
        dir.data,
        '--output-format',
        'json',
        '--usage-log',
        dir.usage,
        '--timeout-ms',
        '60000',
        ...providerArgs(),
      ],
      {}
    );
    expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      exitReason: string;
      turns: number;
      goal?: { status: string; note?: string };
    };
    expect(parsed.exitReason).toBe('completed');
    expect(parsed.goal?.status).toBe('completed');
    expect(parsed.turns).toBe(1);
  });

  it('exits 4 when automatic goal turns are exhausted', async () => {
    const dir = workspace();
    const result = await runCli(
      [
        '--goal',
        'keep going',
        '--auto-turns',
        '1',
        '--cwd',
        dir.work,
        '--data-dir',
        dir.data,
        '--output-format',
        'json',
        '--timeout-ms',
        '60000',
        ...providerArgs(),
      ],
      {}
    );
    expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(4);
    const parsed = JSON.parse(result.stdout) as { exitReason: string; turns: number };
    expect(parsed.exitReason).toBe('auto-turns-exhausted');
    expect(parsed.turns).toBe(1);
  });
});
