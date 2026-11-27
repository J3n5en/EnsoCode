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
  mode: 'default' | 'wakeup' | 'wakeup-long' | 'reminder';
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

function bashToolCallEvents(command: string, id: string): unknown[] {
  const base = {
    id: 'chatcmpl_bash',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'stub-model',
  };
  return [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            content: 'Starting it in the background.',
            tool_calls: [
              {
                index: 0,
                id,
                type: 'function',
                function: {
                  name: 'bash',
                  arguments: JSON.stringify({ command, background: true }),
                },
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

function reminderToolCallEvents(id: string): unknown[] {
  const base = {
    id: 'chatcmpl_remind',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'stub-model',
  };
  return [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            content: 'Setting a reminder.',
            tool_calls: [
              {
                index: 0,
                id,
                type: 'function',
                function: {
                  name: 'remind_me',
                  arguments: JSON.stringify({ in: '30s', prompt: 'WAKE-ME-PING', label: 'ping' }),
                },
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
    mode: 'default',
    close: async () => undefined,
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push(`${req.method} ${req.url} ${body}`);
      if (stub.hold) return;
      if (stub.mode === 'wakeup' || stub.mode === 'wakeup-long') {
        writeCompletion(res, wakeupResponse(stub.mode, body));
        return;
      }
      if (stub.mode === 'reminder') {
        writeCompletion(res, reminderResponse(body));
        return;
      }
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

/**
 * 唤醒验证的状态机：第一轮看到 START-BG 就起后台任务，本轮收口时任务还在跑；
 * 进程若提前退出就永远等不到完成通知那一轮（CONSUMED-BG 永远不会出现）。
 */
function wakeupResponse(mode: 'wakeup' | 'wakeup-long', body: string): unknown[] {
  const command =
    mode === 'wakeup'
      ? 'sleep 0.5; echo bg-finished > bgdone.txt'
      : 'sleep 30; echo never > never.txt';
  if (body.includes('START-BG') && !body.includes('call_bg')) {
    return bashToolCallEvents(command, 'call_bg');
  }
  if (body.includes('reminder') || body.includes('wrap up')) {
    // hold 上限到点后的强制收尾轮 / 后台完成通知轮：都是唤醒生效的证据
    return textEvents('CONSUMED-BG');
  }
  if (body.includes('call_bg')) {
    // 同一轮里 bash 工具结果回来：任务还在跑，agent 收尾等待唤醒
    return textEvents('WAITING-BG');
  }
  return textEvents('CONSUMED-BG');
}

function reminderResponse(body: string): unknown[] {
  if (body.includes('WAKE-ME-PING')) {
    // 提醒到点被注入：是唤醒生效的证据
    return textEvents('REMINDER-CONSUMED');
  }
  if (body.includes('call_remind')) return textEvents('REMINDER-SET');
  if (body.includes('SET-REMINDER')) return reminderToolCallEvents('call_remind');
  return textEvents('hello from stub');
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

  it('appends --append-system-prompt to the system prompt sent to the model', async () => {
    const dir = workspace();
    const marker = 'EVAL-SENTINEL-7f3a9c';
    const seen = stub.requests.length;
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
        '--timeout-ms',
        '60000',
        '--append-system-prompt',
        marker,
        ...providerArgs(),
      ],
      {}
    );
    expect(result.code, result.stderr).toBe(0);
    const requestBody = stub.requests
      .slice(seen)
      .find((entry) => entry.includes('chat/completions'));
    expect(requestBody).toBeTruthy();
    // system prompt 正文必须带着追加段到达模型端点
    expect(requestBody).toContain(marker);
  }, 30_000);

  const firstCompletionTools = (since: number): string[] => {
    const entry = stub.requests
      .slice(since)
      .find((request) => request.includes('chat/completions'));
    if (!entry) return [];
    const at = entry.indexOf('chat/completions') + 'chat/completions'.length;
    const json = entry.slice(at).trim();
    try {
      const body = JSON.parse(json) as {
        tools?: Array<{ function?: { name?: string }; name?: string }>;
      };
      return (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name ?? '');
    } catch {
      return [];
    }
  };

  it('no --goal：goal_complete 族工具不发给模型（假完成误导的来源）', async () => {
    const dir = workspace();
    const seen = stub.requests.length;
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
        '--timeout-ms',
        '60000',
        ...providerArgs(),
      ],
      {}
    );
    expect(result.code, result.stderr).toBe(0);
    const tools = firstCompletionTools(seen);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools).not.toContain('goal_complete');
    expect(tools).not.toContain('goal_blocked');
    expect(tools).not.toContain('goal_wait');
  }, 30_000);

  it('有 --goal：goal_complete 族工具照常发给模型', async () => {
    const dir = workspace();
    const seen = stub.requests.length;
    const result = await runCli(
      [
        '--goal',
        'ship the stub',
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
    expect(result.code, result.stderr).toBe(0);
    expect(firstCompletionTools(seen)).toContain('goal_complete');
  }, 30_000);

  it('后台任务未完结时进程不退出；完成通知唤醒 agent 消费成果后才结束', async () => {
    const dir = workspace();
    stub.mode = 'wakeup';
    try {
      const result = await runCli(
        [
          '--prompt',
          'START-BG in the background then report',
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
      expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        exitReason: string;
        finalMessage: string;
        turns: number;
      };
      // 关键证据：agent 完成了第二轮（完成通知唤醒）并消费了后台成果，
      // 否则进程在第一轮结束就已退出，CONSUMED-BG 根本不会出现
      expect(parsed.finalMessage).toContain('CONSUMED-BG');
      expect(parsed.turns).toBeGreaterThanOrEqual(2);
      expect(existsSync(path.join(dir.work, 'bgdone.txt'))).toBe(true);
    } finally {
      stub.mode = 'default';
    }
  }, 30_000);

  it('后台任务挂死不到完成：hold 上限强制收尾，退出码 3 而不是无限等', async () => {
    const dir = workspace();
    stub.mode = 'wakeup-long';
    try {
      const result = await runCli(
        [
          '--prompt',
          'START-BG in the background then report',
          '--cwd',
          dir.work,
          '--data-dir',
          dir.data,
          '--output-format',
          'json',
          '--hold-timeout-ms',
          '3000',
          '--timeout-ms',
          '60000',
          ...providerArgs(),
        ],
        {}
      );
      expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(3);
      const parsed = JSON.parse(result.stdout) as { exitReason: string };
      expect(parsed.exitReason).toBe('hold-expired');
      // sleep 30 的任务被收割在 hold 上限语义内，进程不该活到 30s
      expect(existsSync(path.join(dir.work, 'never.txt'))).toBe(false);
    } finally {
      stub.mode = 'default';
    }
  }, 30_000);

  it('提醒未触发时进程不退出；到点唤醒 agent 消费提醒后才结束', async () => {
    const dir = workspace();
    stub.mode = 'reminder';
    try {
      const result = await runCli(
        [
          '--prompt',
          'SET-REMINDER for me please',
          '--cwd',
          dir.work,
          '--data-dir',
          dir.data,
          '--output-format',
          'json',
          '--timeout-ms',
          '120000',
          ...providerArgs(),
        ],
        {}
      );
      expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        exitReason: string;
        finalMessage: string;
        turns: number;
      };
      expect(parsed.finalMessage).toContain('REMINDER-CONSUMED');
      expect(parsed.turns).toBeGreaterThanOrEqual(2);
    } finally {
      stub.mode = 'default';
    }
  }, 120_000);
});
