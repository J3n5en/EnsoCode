import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import { type BackgroundTaskManager, withBackground } from '../backgroundTasks';
import { toBashRuntimePath, withRtkOptimization } from './index';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), name));
  tempDirs.push(dir);
  return dir;
}

function fakeRtk(body: string): string {
  const dir = tempDir('enso-rtk-bin-');
  const file = path.join(dir, 'rtk');
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

function baseTool(name: 'bash' | 'powershell' = 'bash') {
  const calls: Array<Record<string, unknown>> = [];
  const definition = {
    name,
    label: name,
    description: '',
    parameters: { type: 'object', properties: {} },
    async execute(_id: string, params: unknown) {
      calls.push(params as Record<string, unknown>);
      return { content: [{ type: 'text' as const, text: 'result' }], details: { existing: true } };
    },
  } as unknown as ToolDefinition;
  return { definition, calls };
}

async function execute(definition: ToolDefinition, command: string, signal?: AbortSignal) {
  return definition.execute('call-1', { command }, signal, undefined, undefined as never);
}

describe('withRtkOptimization', () => {
  it('通过绝对 binary rewrite，并把隔离 DB 的 gain 统计合并到原 details', async () => {
    const logPath = path.join(tempDir('enso-rtk-log-'), 'calls.jsonl');
    const binaryPath = fakeRtk(`
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args: process.argv.slice(2), db: process.env.RTK_DB_PATH }) + '\\n');
if (process.argv[2] === 'rewrite') { process.stdout.write('rtk git status'); process.exit(3); }
if (process.argv[2] === 'gain') process.stdout.write(JSON.stringify({ summary: { total_commands: 1, total_input: 100, total_output: 25, total_saved: 75, avg_savings_pct: 75 } }));
`);
    const dataDir = tempDir('enso rtk data-');
    const { definition, calls } = baseTool();
    const wrapped = withRtkOptimization(definition, { binaryPath, dataDir, cwd: process.cwd() });

    const result = await execute(wrapped, 'git status');

    expect(calls).toHaveLength(1);
    expect(calls[0].command).not.toBe('git status');
    expect(calls[0].command).toContain(binaryPath);
    expect(calls[0].command).toContain('RTK_DB_PATH');
    expect(calls[0].command).toContain('RTK_RECALL');
    expect(result.details).toEqual({
      existing: true,
      rtk: {
        status: 'compressed',
        originalCommand: 'git status',
        rewrittenCommand: 'rtk git status',
        inputTokens: 100,
        outputTokens: 25,
      },
    });
    const invocations = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[]; db: string });
    expect(invocations.map((entry) => entry.args)).toEqual([
      ['rewrite', 'git status'],
      ['gain', '--format', 'json'],
    ]);
    expect(invocations[0].db).toBe(invocations[1].db);
    expect(invocations[0].db).not.toBe(process.env.RTK_DB_PATH);
  });

  it('rewrite 未支持时原命令只执行一次且不调用 gain', async () => {
    const logPath = path.join(tempDir('enso-rtk-log-'), 'calls.txt');
    const binaryPath = fakeRtk(`
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(logPath)}, process.argv[2] + '\\n');
process.exit(1);
`);
    const { definition, calls } = baseTool();
    const wrapped = withRtkOptimization(definition, {
      binaryPath,
      dataDir: tempDir('enso-rtk-data-'),
      cwd: process.cwd(),
    });

    const result = await execute(wrapped, 'unknown-tool --verbose');

    expect(calls).toEqual([{ command: 'unknown-tool --verbose' }]);
    expect(readFileSync(logPath, 'utf8')).toBe('rewrite\n');
    expect(result.details).toEqual({
      existing: true,
      rtk: {
        status: 'unchanged',
        originalCommand: 'unknown-tool --verbose',
        reason: 'unsupported',
      },
    });
  });

  it('gain 没有实际节省时标记 unchanged，而不是 compressed', async () => {
    const binaryPath = fakeRtk(`
if (process.argv[2] === 'rewrite') { process.stdout.write('rtk git status'); process.exit(3); }
if (process.argv[2] === 'gain') process.stdout.write(JSON.stringify({ summary: { total_commands: 1, total_input: 20, total_output: 20 } }));
`);
    const { definition } = baseTool();
    const wrapped = withRtkOptimization(definition, {
      binaryPath,
      dataDir: tempDir('enso-rtk-data-'),
      cwd: process.cwd(),
    });

    const result = await execute(wrapped, 'git status');

    expect(result.details).toMatchObject({
      rtk: {
        status: 'unchanged',
        originalCommand: 'git status',
        rewrittenCommand: 'rtk git status',
        inputTokens: 20,
        outputTokens: 20,
      },
    });
  });

  it('gain 失败或没有统计时标记 unavailable 且保留 rewrite', async () => {
    const binaryPath = fakeRtk(`
if (process.argv[2] === 'rewrite') { process.stdout.write('rtk git status'); process.exit(3); }
if (process.argv[2] === 'gain') process.exit(2);
`);
    const { definition } = baseTool();
    const wrapped = withRtkOptimization(definition, {
      binaryPath,
      dataDir: tempDir('enso-rtk-data-'),
      cwd: process.cwd(),
    });

    const result = await execute(wrapped, 'git status');

    expect(result.details).toMatchObject({
      rtk: {
        status: 'unavailable',
        reason: 'statistics-unavailable',
        originalCommand: 'git status',
        rewrittenCommand: 'rtk git status',
      },
    });
    expect((result.details as { rtk: object }).rtk).not.toHaveProperty('inputTokens');
  });

  it('关闭时直接返回原 definition，不挂 RTK 状态或执行开销', async () => {
    const { definition, calls } = baseTool();
    const wrapped = withRtkOptimization(definition, {
      binaryPath: '/missing/rtk',
      dataDir: tempDir('enso-rtk-data-'),
      cwd: process.cwd(),
      enabled: false,
    });

    expect(wrapped).toBe(definition);
    const result = await execute(wrapped, 'git status');
    expect(calls).toEqual([{ command: 'git status' }]);
    expect(result.details).toEqual({ existing: true });
  });

  it('rewrite 超时后执行原命令一次', async () => {
    const binaryPath = fakeRtk(`setTimeout(() => {}, 10_000);`);
    const { definition, calls } = baseTool();
    const wrapped = withRtkOptimization(definition, {
      binaryPath,
      dataDir: tempDir('enso-rtk-data-'),
      cwd: process.cwd(),
      rewriteTimeoutMs: 20,
    });

    const result = await execute(wrapped, 'git status');

    expect(calls).toEqual([{ command: 'git status' }]);
    expect(result.details).toMatchObject({
      rtk: { status: 'unavailable', originalCommand: 'git status', reason: 'rewrite-timeout' },
    });
  });

  it('rewrite 空输出或 binary 异常时均只回退一次', async () => {
    const emptyBinary = fakeRtk('process.exit(0);');
    const { definition, calls } = baseTool();
    const options = { dataDir: tempDir('enso-rtk-data-'), cwd: process.cwd() };

    const emptyResult = await execute(
      withRtkOptimization(definition, { ...options, binaryPath: emptyBinary }),
      'git status'
    );
    const missingResult = await execute(
      withRtkOptimization(definition, {
        ...options,
        binaryPath: path.join(options.dataDir, 'missing-rtk'),
      }),
      'git diff'
    );

    expect(calls).toEqual([{ command: 'git status' }, { command: 'git diff' }]);
    expect(emptyResult.details).toMatchObject({ rtk: { reason: 'empty-rewrite' } });
    expect(missingResult.details).toMatchObject({ rtk: { reason: 'rewrite-error' } });
  });

  it('rewrite 取消时不执行原命令', async () => {
    const binaryPath = fakeRtk('setTimeout(() => {}, 10_000);');
    const { definition, calls } = baseTool();
    const wrapped = withRtkOptimization(definition, {
      binaryPath,
      dataDir: tempDir('enso-rtk-data-'),
      cwd: process.cwd(),
    });
    const controller = new AbortController();
    controller.abort();

    await expect(execute(wrapped, 'git status', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(calls).toHaveLength(0);
  });

  it('有效 rewrite 执行失败时不回跑原命令', async () => {
    const binaryPath = fakeRtk(`
if (process.argv[2] === 'rewrite') { process.stdout.write('rtk git status'); process.exit(3); }
if (process.argv[2] === 'gain') process.stdout.write(JSON.stringify({ summary: { total_commands: 0, total_input: 0, total_output: 0 } }));
`);
    const calls: string[] = [];
    const definition = {
      ...baseTool().definition,
      async execute(_id: string, params: unknown) {
        calls.push((params as { command: string }).command);
        return { content: [{ type: 'text' as const, text: 'failed' }], details: { exitCode: 2 } };
      },
    } as ToolDefinition;
    const wrapped = withRtkOptimization(definition, {
      binaryPath,
      dataDir: tempDir('enso-rtk-data-'),
      cwd: process.cwd(),
    });

    await execute(wrapped, 'git status');

    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toBe('git status');
  });

  it('远程会话不探测本机 binary，直接原样执行', async () => {
    const marker = path.join(tempDir('enso-rtk-log-'), 'called');
    const binaryPath = fakeRtk(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x');`);
    const { definition, calls } = baseTool();
    const wrapped = withRtkOptimization(definition, {
      binaryPath,
      dataDir: tempDir('enso-rtk-data-'),
      cwd: process.cwd(),
      remote: true,
    });

    const result = await execute(wrapped, 'git status');

    expect(calls).toEqual([{ command: 'git status' }]);
    expect(() => readFileSync(marker)).toThrow();
    expect(result.details).toMatchObject({
      rtk: { status: 'bypassed', originalCommand: 'git status', reason: 'remote' },
    });
  });

  it('PowerShell 原生命令和对象管道 bypass，不按 Bash 语义 rewrite', async () => {
    const marker = path.join(tempDir('enso-rtk-log-'), 'called');
    const binaryPath = fakeRtk(
      `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x');`
    );
    const { definition, calls } = baseTool('powershell');
    const wrapped = withRtkOptimization(definition, {
      binaryPath,
      dataDir: tempDir('enso-rtk-data-'),
      cwd: process.cwd(),
      shell: 'powershell',
    });

    const nativeResult = await execute(wrapped, 'Get-ChildItem | Where-Object Length -gt 0');
    const aliasResult = await execute(wrapped, 'ls');
    const interpolationResult = await execute(wrapped, 'git log --format "$env:HOME"');

    expect(calls).toEqual([
      { command: 'Get-ChildItem | Where-Object Length -gt 0' },
      { command: 'ls' },
      { command: 'git log --format "$env:HOME"' },
    ]);
    expect(() => readFileSync(marker)).toThrow();
    expect(nativeResult.details).toMatchObject({ rtk: { status: 'bypassed' } });
    expect(aliasResult.details).toMatchObject({ rtk: { status: 'bypassed' } });
    expect(interpolationResult.details).toMatchObject({ rtk: { status: 'bypassed' } });
  });

  it('PowerShell 简单外部命令以调用运算符绑定绝对 binary', async () => {
    const binaryPath = fakeRtk(`
if (process.argv[2] === 'rewrite') { process.stdout.write('rtk git status'); process.exit(3); }
if (process.argv[2] === 'gain') process.stdout.write(JSON.stringify({ summary: { total_commands: 1, total_input: 8, total_output: 4 } }));
`);
    const { definition, calls } = baseTool('powershell');
    const wrapped = withRtkOptimization(definition, {
      binaryPath,
      dataDir: tempDir('enso-rtk-data-'),
      cwd: process.cwd(),
      shell: 'powershell',
    });

    await execute(wrapped, 'git status');

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toContain(`& '${binaryPath.replaceAll("'", "''")}' git status`);
    expect(calls[0].command).not.toContain('export ');
    expect(calls[0].command).toMatch(/rtk' git status\s*$/);
  });

  it('Bash shell-local 函数保留 RTK 子命令退出码', async () => {
    const binaryPath = fakeRtk(`
if (process.argv[2] === 'rewrite') { process.stdout.write('rtk fail'); process.exit(3); }
if (process.argv[2] === 'fail') process.exit(7);
if (process.argv[2] === 'gain') process.stdout.write(JSON.stringify({ summary: { total_commands: 1, total_input: 4, total_output: 2 } }));
`);
    const { definition, calls } = baseTool();
    const wrapped = withRtkOptimization(definition, {
      binaryPath,
      dataDir: tempDir('enso-rtk-data-'),
      cwd: process.cwd(),
    });

    await execute(wrapped, 'git status');
    const outcome = spawnSync('/bin/sh', ['-c', String(calls[0].command)]);

    expect(outcome.status).toBe(7);
  });

  it('Bash 外部 env 包装器从当前 shell PATH 找到 bundled RTK', async () => {
    const binaryPath = fakeRtk(`
if (process.argv[2] === 'rewrite') { process.stdout.write('env FOO=bar rtk probe'); process.exit(3); }
if (process.argv[2] === 'probe') process.exit(process.env.FOO === 'bar' ? 9 : 8);
if (process.argv[2] === 'gain') process.stdout.write(JSON.stringify({ summary: { total_commands: 1, total_input: 4, total_output: 2 } }));
`);
    const { definition, calls } = baseTool();
    const wrapped = withRtkOptimization(definition, {
      binaryPath,
      dataDir: tempDir('enso-rtk-data-'),
      cwd: process.cwd(),
    });

    await execute(wrapped, 'env FOO=bar git status');
    const outcome = spawnSync('/bin/sh', ['-c', String(calls[0].command)], {
      env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` },
    });

    expect(outcome.status).toBe(9);
    expect(calls[0].command).toContain(`PATH='${path.dirname(binaryPath)}':"$PATH"`);
  });

  it('Windows bundled 路径转换为 Git Bash 可执行的 MSYS 路径', () => {
    expect(toBashRuntimePath('C:\\Program Files\\Enso\\resources\\rtk\\rtk.exe', 'win32')).toBe(
      '/c/Program Files/Enso/resources/rtk/rtk.exe'
    );
  });

  it('会清空 PATH 的包装器明确 bypass，不执行必然失败的 rewrite', async () => {
    const binaryPath = fakeRtk(`
if (process.argv[2] === 'rewrite') { process.stdout.write('env -i rtk git status'); process.exit(3); }
if (process.argv[2] === 'gain') throw new Error('gain should not run');
`);
    const { definition, calls } = baseTool();
    const wrapped = withRtkOptimization(definition, {
      binaryPath,
      dataDir: tempDir('enso-rtk-data-'),
      cwd: process.cwd(),
    });

    const result = await execute(wrapped, 'env -i git status');

    expect(calls).toEqual([{ command: 'env -i git status' }]);
    expect(result.details).toMatchObject({
      rtk: { status: 'bypassed', reason: 'unsafe-wrapper' },
    });
  });

  it.each([
    ['PATH=/usr/bin command git status', 'PATH=/usr/bin command rtk git status'],
    ['PATH=/usr/bin timeout 5 git status', 'PATH=/usr/bin timeout 5 rtk git status'],
  ])('PATH 前缀覆盖 bundled PATH 时 bypass：%s', async (originalCommand, rewrittenCommand) => {
    const binaryPath = fakeRtk(`
if (process.argv[2] === 'rewrite') { process.stdout.write(${JSON.stringify(rewrittenCommand)}); process.exit(3); }
if (process.argv[2] === 'gain') throw new Error('gain should not run');
`);
    const { definition, calls } = baseTool();
    const wrapped = withRtkOptimization(definition, {
      binaryPath,
      dataDir: tempDir('enso-rtk-data-'),
      cwd: process.cwd(),
    });

    const result = await execute(wrapped, originalCommand);

    expect(calls).toEqual([{ command: originalCommand }]);
    expect(result.details).toMatchObject({
      rtk: { status: 'bypassed', reason: 'unsafe-wrapper' },
    });
  });

  it('显式 recall 绑定内置 binary 与持久 recovery DB，不开放 config 改写', async () => {
    const binaryPath = fakeRtk('');
    const dataDir = tempDir('enso-rtk-data-');
    const { definition, calls } = baseTool();
    const wrapped = withRtkOptimization(definition, { binaryPath, dataDir, cwd: process.cwd() });

    const recall = await execute(wrapped, 'rtk recall abc123');
    await execute(wrapped, 'rtk config recall disabled');

    expect(calls[0].command).toContain(binaryPath);
    expect(calls[0].command).toContain(path.join(dataDir, 'recall.db'));
    expect(calls[1]).toEqual({ command: 'rtk config recall disabled' });
    expect(recall.details).toMatchObject({
      rtk: { status: 'bypassed', reason: 'readonly-rtk', originalCommand: 'rtk recall abc123' },
    });
  });

  it('上游 git diff --no-compact 恢复提示绑定 bundled binary', async () => {
    const binaryPath = fakeRtk(`
if (process.argv.slice(2).join(' ') === 'git diff --no-compact') process.exit(11);
process.exit(12);
`);
    const { definition, calls } = baseTool();
    const wrapped = withRtkOptimization(definition, {
      binaryPath,
      dataDir: tempDir('enso-rtk-data-'),
      cwd: process.cwd(),
    });

    const result = await execute(wrapped, '  rtk   git diff   --no-compact  ');
    const outcome = spawnSync('/bin/sh', ['-c', String(calls[0].command)], {
      env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` },
    });

    expect(calls[0].command).toContain(binaryPath);
    expect(outcome.status).toBe(11);
    expect(result.details).toMatchObject({
      rtk: {
        status: 'bypassed',
        reason: 'readonly-rtk',
        originalCommand: '  rtk   git diff   --no-compact  ',
      },
    });
  });

  it('并发 toolCall 使用不同 DB，且不修改 process.env', async () => {
    const logPath = path.join(tempDir('enso-rtk-log-'), 'db.txt');
    const binaryPath = fakeRtk(`
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(logPath)}, process.env.RTK_DB_PATH + '\\n');
if (process.argv[2] === 'rewrite') { process.stdout.write('rtk git status'); process.exit(3); }
if (process.argv[2] === 'gain') process.stdout.write(JSON.stringify({ summary: { total_commands: 1, total_input: 4, total_output: 2 } }));
`);
    const before = { ...process.env };
    const { definition } = baseTool();
    const wrapped = withRtkOptimization(definition, {
      binaryPath,
      dataDir: tempDir('enso-rtk-data-'),
      cwd: process.cwd(),
    });

    await Promise.all([execute(wrapped, 'git status'), execute(wrapped, 'git status')]);

    const paths = readFileSync(logPath, 'utf8').trim().split('\n');
    expect(paths).toHaveLength(4);
    const counts = new Map<string, number>();
    for (const dbPath of paths) counts.set(dbPath, (counts.get(dbPath) ?? 0) + 1);
    expect([...counts.values()].sort()).toEqual([2, 2]);
    expect(process.env).toEqual(before);
  });

  it('background 启动返回 pending，完成 hook 再返回隔离 gain 统计', async () => {
    const binaryPath = fakeRtk(`
if (process.argv[2] === 'rewrite') { process.stdout.write('rtk git status'); process.exit(3); }
if (process.argv[2] === 'gain') process.stdout.write(JSON.stringify({ summary: { total_commands: 1, total_input: 40, total_output: 10 } }));
`);
    const { definition, calls } = baseTool();
    const optimized = withRtkOptimization(definition, {
      binaryPath,
      dataDir: tempDir('enso-rtk-data-'),
      cwd: process.cwd(),
    });
    let launch:
      | { command: string; finalize?: () => Promise<unknown>; details?: unknown }
      | undefined;
    const manager = {
      start(_sessionId: string, command: string, _cwd: string, options?: typeof launch) {
        launch = { command, ...options };
        return 'task-1';
      },
    } as unknown as BackgroundTaskManager;
    const wrapped = withBackground(optimized, manager, 's1', process.cwd());

    const started = await wrapped.execute(
      'call-bg',
      { command: 'git status', background: true },
      undefined,
      undefined,
      undefined as never
    );

    expect(calls).toHaveLength(0);
    expect(started.details).toEqual({
      rtk: {
        status: 'pending',
        originalCommand: 'git status',
        rewrittenCommand: 'rtk git status',
      },
    });
    expect(launch?.command).toContain(binaryPath);
    expect(await launch?.finalize?.()).toEqual({
      rtk: {
        status: 'compressed',
        originalCommand: 'git status',
        rewrittenCommand: 'rtk git status',
        inputTokens: 40,
        outputTokens: 10,
      },
    });
  });
});
