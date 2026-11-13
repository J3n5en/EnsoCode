import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunArgs } from './args';

// `enso-server run` 跑在服务端平台上：数据目录由 ENSO_DATA_DIR 决定。
// 导入前就指向临时目录，任何模块导入期取 userData 都碰不到开发机上真实的 ~/.enso-server
const root = mkdtempSync(path.join(tmpdir(), 'enso-run-exec-'));
const savedDataDir = process.env.ENSO_DATA_DIR;
process.env.ENSO_DATA_DIR = path.join(root, 'import');
vi.mock('@platform', () => import('../platform'));

const { executeRun } = await import('./execute');

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(root, 'case-'));
  process.env.ENSO_DATA_DIR = path.join(tmp, 'data');
});

afterAll(() => {
  if (savedDataDir === undefined) delete process.env.ENSO_DATA_DIR;
  else process.env.ENSO_DATA_DIR = savedDataDir;
  rmSync(root, { recursive: true, force: true });
});

/** 标志给出 key + base URL：run 会新建供应商并写回 settings.json */
function runArgs(extra: Partial<RunArgs> = {}): RunArgs {
  return {
    prompt: 'hi',
    cwd: tmp,
    mode: 'full',
    autoTurns: 25,
    modelId: 'stub-model',
    apiKey: 'key',
    baseUrl: 'http://127.0.0.1:9/v1',
    outputFormat: 'text',
    continue: false,
    disallowedTools: [],
    allowTools: [],
    ...extra,
  };
}

async function run(args: RunArgs) {
  const out = { stdout: '', stderr: '' };
  const code = await executeRun(args, {
    writeStdout: (chunk) => {
      out.stdout += chunk;
    },
    writeStderr: (chunk) => {
      out.stderr += chunk;
    },
    readStdin: () => '',
    signal: new AbortController().signal,
  });
  return { code, ...out };
}

// docs/enso-server-run.md：参数或配置错误退出码 2、stdout 为空。之前这些写盘失败以未处理
// rejection 退出（码 1 + 堆栈）
describe('executeRun 写盘失败按配置错误退出', () => {
  it('数据目录建不出来时退出码 2', async () => {
    writeFileSync(path.join(tmp, 'blocker'), '');
    process.env.ENSO_DATA_DIR = path.join(tmp, 'blocker', 'data');
    const result = run(runArgs());
    await expect(result).resolves.toMatchObject({ code: 2, stdout: '' });
    expect((await result).stderr).not.toBe('');
  });

  it('供应商配置写不进 settings.json 时退出码 2', async () => {
    // 临时文件位置被目录占住，writeFileSync 必然失败（不依赖文件权限，root 下同样成立）
    mkdirSync(path.join(tmp, 'data', 'settings.json.tmp'), { recursive: true });
    const result = run(runArgs());
    await expect(result).resolves.toMatchObject({ code: 2, stdout: '' });
    expect((await result).stderr).toContain('settings.json');
  });

  it('--usage-log 路径不可写时退出码 2', async () => {
    writeFileSync(path.join(tmp, 'blocker'), '');
    const result = run(runArgs({ usageLog: path.join(tmp, 'blocker', 'usage.jsonl') }));
    await expect(result).resolves.toMatchObject({ code: 2, stdout: '' });
    expect((await result).stderr).toContain('usage.jsonl');
  });
});
