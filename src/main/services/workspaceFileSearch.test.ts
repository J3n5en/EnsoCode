import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildContentSearchArgs,
  buildNameSearchArgs,
  parseRipgrepJsonMatch,
  type RgRunner,
  rankNameHits,
  resolveRgFromPath,
  ripgrepCandidates,
  runRipgrep,
  searchWorkspaceFiles,
  toRelativePosix,
} from './workspaceFileSearch';

describe('toRelativePosix', () => {
  it('只接受 cwd 内路径并转 posix', () => {
    const root = path.join('/tmp', 'ws');
    expect(toRelativePosix(root, path.join(root, 'src', 'a.ts'))).toBe('src/a.ts');
    expect(toRelativePosix(root, path.join(root, '..', 'escape.ts'))).toBeNull();
    expect(toRelativePosix(root, '/etc/passwd')).toBeNull();
  });
});

describe('rankNameHits', () => {
  it('按文件名模糊排序且不含绝对路径', () => {
    const hits = rankNameHits(['src/ChatView.tsx', 'src/chat.ts', 'README.md'], 'chat', 10);
    expect(hits[0]?.relativePath).toBe('src/chat.ts');
    expect(hits.map((hit) => hit.name)).toContain('ChatView.tsx');
    expect(JSON.stringify(hits)).not.toMatch(/[/\\]tmp|C:\\/i);
  });

  it('空查询不返回清单', () => {
    expect(rankNameHits(['a.ts'], '  ', 10)).toEqual([]);
  });
});

describe('parseRipgrepJsonMatch', () => {
  it('抽出相对路径与行列，丢掉绝对 path', () => {
    const root = path.join('/tmp', 'ws');
    const hit = parseRipgrepJsonMatch(
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: path.join(root, 'src', 'a.ts') },
          line_number: 3,
          lines: { text: 'hello world\n' },
          submatches: [{ start: 6, end: 11 }],
        },
      }),
      root
    );
    expect(hit).toEqual({
      relativePath: 'src/a.ts',
      line: 3,
      column: 6,
      matchLength: 5,
      content: 'hello world',
    });
  });

  it('cwd 外命中丢弃', () => {
    expect(
      parseRipgrepJsonMatch(
        JSON.stringify({
          type: 'match',
          data: {
            path: { text: '/etc/passwd' },
            line_number: 1,
            lines: { text: 'root' },
            submatches: [{ start: 0, end: 4 }],
          },
        }),
        path.join('/tmp', 'ws')
      )
    ).toBeNull();
  });
});

describe('rg args', () => {
  it('文件名搜索只列文件', () => {
    expect(buildNameSearchArgs()).toEqual(
      expect.arrayContaining(['--files', '--glob', '!node_modules/**', '.'])
    );
  });

  it('内容搜索在 -- 之后才放查询', () => {
    expect(
      buildContentSearchArgs({
        query: '--help',
        caseSensitive: false,
        wholeWord: true,
        regex: false,
      })
    ).toEqual(expect.arrayContaining(['--json', '-i', '-w', '-F', '--', '--help', '.']));
  });
});

describe('searchWorkspaceFiles', () => {
  it('names 模式用列举结果做模糊命中', async () => {
    const run = vi.fn(async () => ({
      code: 0,
      stdout: 'src/chat.ts\nsrc/ChatView.tsx\n',
    }));
    const result = await searchWorkspaceFiles(
      '/tmp/ws',
      {
        conversationId: 'c',
        projectId: 'p',
        query: 'chat',
        mode: 'names',
        maxResults: 10,
        caseSensitive: false,
        wholeWord: false,
        regex: false,
      },
      run
    );
    expect(run).toHaveBeenCalledWith(buildNameSearchArgs(), '/tmp/ws', { signal: undefined });
    expect(result).toEqual({
      ok: true,
      mode: 'names',
      hits: [
        { relativePath: 'src/chat.ts', name: 'chat.ts' },
        { relativePath: 'src/ChatView.tsx', name: 'ChatView.tsx' },
      ],
    });
  });

  it('content 空查询不跑 rg', async () => {
    const run = vi.fn();
    await expect(
      searchWorkspaceFiles(
        '/tmp/ws',
        {
          conversationId: 'c',
          projectId: 'p',
          query: '  ',
          mode: 'content',
          maxResults: 10,
          caseSensitive: false,
          wholeWord: false,
          regex: false,
        },
        run
      )
    ).resolves.toEqual({ ok: true, mode: 'content', hits: [], truncated: false });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('searchWorkspaceFiles 真机 rg', () => {
  it('能搜到文件名和内容', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enso-rg-'));
    try {
      fs.mkdirSync(path.join(tmp, 'src'));
      fs.writeFileSync(path.join(tmp, 'src', 'hello.ts'), 'uniqueTokenAlpha\n');
      const names = await searchWorkspaceFiles(tmp, {
        conversationId: 'c',
        projectId: 'p',
        query: 'hello',
        mode: 'names',
        maxResults: 10,
        caseSensitive: false,
        wholeWord: false,
        regex: false,
      });
      expect(names).toEqual({
        ok: true,
        mode: 'names',
        hits: [{ relativePath: 'src/hello.ts', name: 'hello.ts' }],
      });
      const content = await searchWorkspaceFiles(tmp, {
        conversationId: 'c',
        projectId: 'p',
        query: 'uniqueTokenAlpha',
        mode: 'content',
        maxResults: 10,
        caseSensitive: false,
        wholeWord: false,
        regex: false,
      });
      expect(content.ok).toBe(true);
      if (!content.ok || content.mode !== 'content') throw new Error('expected content hits');
      expect(content.hits[0]).toMatchObject({
        relativePath: 'src/hello.ts',
        line: 1,
        content: 'uniqueTokenAlpha',
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('runRipgrep 候选回退', () => {
  const node = process.execPath;

  it('随包二进制起不来时退到下一个候选', async () => {
    const result = await runRipgrep(
      [path.join(os.tmpdir(), 'enso-missing-rg'), node],
      ['-e', 'process.stdout.write("hit")'],
      process.cwd()
    );
    expect(result).toEqual({ code: 0, stdout: 'hit' });
  });

  it('所有候选都起不来时标记 missing', async () => {
    const result = await runRipgrep(
      [path.join(os.tmpdir(), 'enso-missing-rg-a'), path.join(os.tmpdir(), 'enso-missing-rg-b')],
      ['--files'],
      process.cwd()
    );
    expect(result).toEqual({ code: 2, stdout: '', failure: 'missing' });
  });

  it('超时杀进程并标记 timeout，保留已收到的输出', async () => {
    const result = await runRipgrep(
      [node],
      ['-e', 'process.stdout.write("partial"); setTimeout(() => {}, 5000)'],
      process.cwd(),
      200
    );
    expect(result).toEqual({ code: 2, stdout: 'partial', failure: 'timeout' });
  });

  it('回退只 spawn PATH 上解析出的绝对路径，不执行工作目录里的 rg', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enso-rg-path-'));
    const cwd = path.join(root, 'ws');
    const bin = path.join(root, 'bin');
    const rel = path.join(root, 'rel');
    fs.mkdirSync(cwd);
    fs.mkdirSync(bin);
    fs.mkdirSync(rel);
    const marker = path.join(root, 'marker');
    const writeRg = (dir: string, label: string) => {
      const file = path.join(dir, 'rg');
      fs.writeFileSync(
        file,
        `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(label)});\n`
      );
      fs.chmodSync(file, 0o755);
    };
    writeRg(cwd, 'cwd');
    writeRg(rel, 'rel');
    writeRg(bin, 'path');
    try {
      const resolved = resolveRgFromPath(['', '.', 'rel', bin].join(path.delimiter));
      expect(resolved).toBe(path.join(bin, 'rg'));
      await runRipgrep([resolved ?? ''], ['--files'], cwd);
      expect(fs.readFileSync(marker, 'utf8')).toBe('path');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('Windows 只接受 PATH 里的绝对目录，并且只找 rg.exe', () => {
    const seen: string[] = [];
    const found = resolveRgFromPath(';.\\rel;C:\\Tools;D:\\bin', {
      platform: 'win32',
      exists: (candidate) => {
        seen.push(candidate);
        return candidate === 'D:\\bin\\rg.exe';
      },
    });
    expect(seen).toEqual(['C:\\Tools\\rg.exe', 'D:\\bin\\rg.exe']);
    expect(found).toBe('D:\\bin\\rg.exe');
    expect(resolveRgFromPath('relative;.', { platform: 'linux', exists: () => true })).toBeNull();
  });

  it('随包 rg 缺失时候选不含裸 rg 名', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enso-rg-candidates-'));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const rg = path.join(bin, 'rg');
    fs.writeFileSync(rg, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(rg, 0o755);
    const previous = process.env.PATH;
    process.env.PATH = ['', '.', path.join(root, 'rel'), bin].join(path.delimiter);
    try {
      const candidates = await ripgrepCandidates();
      expect(candidates.some((candidate) => candidate === 'rg' || candidate === 'rg.exe')).toBe(
        false
      );
      expect(candidates).toContain(rg);
      expect(candidates.every((candidate) => path.isAbsolute(candidate))).toBe(true);
    } finally {
      process.env.PATH = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('searchWorkspaceFiles 错误码', () => {
  const request = {
    conversationId: 'c',
    projectId: 'p',
    query: 'x',
    maxResults: 10,
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  } as const;

  it('rg 缺失报 rg-missing，而不是笼统的 unavailable', async () => {
    const run = vi.fn(async () => ({ code: 2, stdout: '', failure: 'missing' as const }));
    await expect(
      searchWorkspaceFiles('/tmp/ws', { ...request, mode: 'names' }, run)
    ).resolves.toEqual({ ok: false, error: 'rg-missing' });
    await expect(
      searchWorkspaceFiles('/tmp/ws', { ...request, mode: 'content' }, run)
    ).resolves.toEqual({ ok: false, error: 'rg-missing' });
  });

  it('超时报 timeout', async () => {
    const run = vi.fn(async () => ({ code: 2, stdout: '', failure: 'timeout' as const }));
    await expect(
      searchWorkspaceFiles('/tmp/ws', { ...request, mode: 'content' }, run)
    ).resolves.toEqual({ ok: false, error: 'timeout' });
  });

  it('rg 自身报错（如非法正则）仍是 unavailable', async () => {
    const run = vi.fn(async () => ({ code: 2, stdout: '' }));
    await expect(
      searchWorkspaceFiles('/tmp/ws', { ...request, mode: 'content', regex: true }, run)
    ).resolves.toEqual({ ok: false, error: 'unavailable' });
  });
});

describe('rg 输出量上限', () => {
  const node = process.execPath;
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enso-rg-flood-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** 临时脚本冒充 rg：忽略参数，先记下 pid，再执行给定的输出逻辑，最后一直挂着不退出 */
  function fakeRg(body: string): { script: string; pidFile: string } {
    const pidFile = path.join(tmp, 'rg.pid');
    const script = path.join(tmp, 'fake-rg.js');
    fs.writeFileSync(
      script,
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n${body}\nsetInterval(() => {}, 1000);\n`
    );
    return { script, pidFile };
  }

  const matchLine = (line: number) =>
    JSON.stringify({
      type: 'match',
      data: {
        path: { text: 'src/a.ts' },
        line_number: line,
        lines: { text: `hit ${line}\n` },
        submatches: [{ start: 0, end: 3 }],
      },
    });

  const hit = (line: number) => ({
    relativePath: 'src/a.ts',
    line,
    column: 0,
    matchLength: 3,
    content: `hit ${line}`,
  });

  const contentRequest = {
    conversationId: 'c',
    projectId: 'p',
    query: 'hit',
    mode: 'content',
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  } as const;

  async function exited(pid: number): Promise<boolean> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  }

  // 审计：单字母查询在本仓库就产生约 73MB JSON，旧实现等 rg 跑完才截取前 maxResults 条
  it('内容搜索拿够结果后立即结束 rg 并标记 truncated', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => matchLine(i + 1)).join('\n');
    const { script, pidFile } = fakeRg(`process.stdout.write(${JSON.stringify(`${lines}\n`)});`);
    const run: RgRunner = (args, cwd, options) =>
      runRipgrep([node], [script, ...args], cwd, 2_000, options);
    const result = await searchWorkspaceFiles(tmp, { ...contentRequest, maxResults: 10 }, run);
    expect(result).toEqual({
      ok: true,
      mode: 'content',
      hits: Array.from({ length: 10 }, (_, i) => hit(i + 1)),
      truncated: true,
    });
    expect(await exited(Number(fs.readFileSync(pidFile, 'utf8')))).toBe(true);
  });

  // 审计：输出无字节上限，更大的仓库会超过 V8 字符串上限，在 data 监听里抛 RangeError 成为主进程未捕获异常
  it('输出超过字节上限时结束 rg，只返回上限内的完整行', async () => {
    const { script } = fakeRg(
      `process.stdout.write(${JSON.stringify(`${'x'.repeat(99)}\n`)}.repeat(20_000));`
    );
    const result = await runRipgrep([node], [script], tmp, 1_500, { maxBytes: 64 * 1024 });
    expect(result.failure).toBeUndefined();
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(64 * 1024);
    expect(result.stdout.endsWith('\n')).toBe(true);
  });

  // 背景：单行巨大（如压缩过的打包产物）时，即使命中数不多也会撑满上限
  it('内容搜索输出超限时返回已解析的命中并标记 truncated', async () => {
    const lines = [1, 2, 3].map(matchLine).join('\n');
    const { script } = fakeRg(
      `process.stdout.write(${JSON.stringify(`${lines}\n`)});\nprocess.stdout.write('y'.repeat(1_000_000));`
    );
    const run: RgRunner = (args, cwd, options) =>
      runRipgrep([node], [script, ...args], cwd, 2_000, { ...options, maxBytes: 64 * 1024 });
    const result = await searchWorkspaceFiles(tmp, { ...contentRequest, maxResults: 10 }, run);
    expect(result).toEqual({
      ok: true,
      mode: 'content',
      hits: [1, 2, 3].map(hit),
      truncated: true,
    });
  });
});

describe('rg 取消', () => {
  const node = process.execPath;
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enso-rg-cancel-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** 临时脚本冒充 rg：记下 pid 后一直挂着，模拟大仓库里一时跑不完的搜索 */
  function hangingRg(): { run: RgRunner; pidFile: string } {
    const pidFile = path.join(tmp, 'rg.pid');
    const script = path.join(tmp, 'hanging-rg.js');
    fs.writeFileSync(
      script,
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`
    );
    return {
      run: (args, cwd, options) => runRipgrep([node], [script, ...args], cwd, 1_500, options),
      pidFile,
    };
  }

  async function pidOf(pidFile: string): Promise<number> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
      if (pid > 0) return pid;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('fake rg did not start');
  }

  async function exited(pid: number): Promise<boolean> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  }

  const request = {
    conversationId: 'c',
    projectId: 'p',
    query: 'hit',
    maxResults: 10,
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  } as const;

  // 审计 F6：renderer 每次按键（150ms 防抖）都发新搜索，旧 rg 不取消就会在大仓库里堆积到超时
  it('内容搜索被取消时结束 rg 并返回 cancelled', async () => {
    const { run, pidFile } = hangingRg();
    const controller = new AbortController();
    const searching = searchWorkspaceFiles(
      tmp,
      { ...request, mode: 'content' },
      run,
      controller.signal
    );
    const pid = await pidOf(pidFile);
    controller.abort();
    expect(await searching).toEqual({ ok: false, error: 'cancelled' });
    expect(await exited(pid)).toBe(true);
  });

  // 背景：取消可能落在查找 rg 候选（动态 import）的间隙里，此时不应再起进程
  it('文件名搜索同样响应取消，已取消时不再启动 rg', async () => {
    const { run, pidFile } = hangingRg();
    expect(
      await searchWorkspaceFiles(tmp, { ...request, mode: 'names' }, run, AbortSignal.abort())
    ).toEqual({ ok: false, error: 'cancelled' });
    expect(fs.existsSync(pidFile)).toBe(false);
  });
});
