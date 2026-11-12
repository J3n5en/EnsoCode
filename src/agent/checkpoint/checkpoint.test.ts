import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CheckpointHost,
  createCheckpoint,
  loadAllCheckpoints,
  MAX_UNTRACKED_FILE_SIZE,
  pruneStaleCheckpoints,
  restoreCheckpoint,
} from './core';
import { CheckpointManager, withCheckpoint } from './manager';

const runGit = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// 每个用例都要建临时 git 仓库，一次 checkpoint 又要 spawn 十几个 git 进程，
// 单例常跑到数秒，5s 默认超时不够。只放宽本文件，避免掩盖别处真正的卡死。
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

let root: string;
let home: string;
let templateRoot: string;

beforeAll(() => {
  templateRoot = mkdtempSync(join(tmpdir(), 'enso-cp-tpl-'));
  runGit(templateRoot, 'init', '-q', '-b', 'main');
  runGit(templateRoot, 'config', 'user.name', 'test');
  runGit(templateRoot, 'config', 'user.email', 'test@test');
  writeFileSync(join(templateRoot, 'a.txt'), 'v1\n');
  runGit(templateRoot, 'add', '.');
  runGit(templateRoot, 'commit', '-q', '-m', 'init');
});

beforeEach(() => {
  // 隔离开发机的全局/系统 git 配置与默认全局 ignore（如 core.quotePath、~/.config/git/ignore），
  // 用例结果只取决于临时仓库本身
  home = mkdtempSync(join(tmpdir(), 'enso-cp-home-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', home);
  vi.stubEnv('GIT_CONFIG_GLOBAL', devNull);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  root = mkdtempSync(join(tmpdir(), 'enso-cp-test-'));
  rmSync(root, { recursive: true, force: true });
  cpSync(templateRoot, root, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
afterAll(() => {
  rmSync(templateRoot, { recursive: true, force: true });
});

describe('createCheckpoint / restoreCheckpoint', () => {
  it('还原被修改与新增的文件,清掉快照后新出现的未跟踪文件', async () => {
    // 快照前已有的未跟踪文件:还原时必须保留
    writeFileSync(join(root, 'pre-existing.txt'), 'keep me\n');
    const cp = await createCheckpoint({
      root,
      id: 'tool-s1-1',
      sessionId: 's1',
      trigger: 'tool',
      entryId: 'e1',
      entryTimestamp: 1000,
    });

    writeFileSync(join(root, 'a.txt'), 'v2\n');
    writeFileSync(join(root, 'new-file.txt'), 'created after\n');

    await restoreCheckpoint(root, cp);

    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v1\n');
    expect(existsSync(join(root, 'new-file.txt'))).toBe(false);
    expect(readFileSync(join(root, 'pre-existing.txt'), 'utf8')).toBe('keep me\n');
  });

  // 真实场景:ls-files 不加 -z 时 git 把非 ASCII、含引号的路径转义成 "\350…",
  // 拼进 clean 命令后匹配不到真实文件,还原后新文件残留(Windows 文件名不允许 ")
  it.skipIf(process.platform === 'win32')(
    '快照后新建的非 ASCII 与含引号文件名的未跟踪文件,还原时都被清掉',
    async () => {
      const cp = await createCheckpoint({
        root,
        id: 'tool-s1-q',
        sessionId: 's1',
        trigger: 'tool',
      });
      const names = ['说明.md', 'a"b.txt', "it's.txt"];
      for (const name of names) writeFileSync(join(root, name), 'new\n');

      await restoreCheckpoint(root, cp);

      expect(names.filter((name) => existsSync(join(root, name)))).toEqual([]);
    }
  );

  // 真实场景:Next.js 动态路由 [id].tsx 当 pathspec 会按通配匹配 d.tsx;
  // 快照时因过大跳过的 d.tsx 不在还原后的 index 里,会被 clean 连带删掉
  it('清理快照后新建的 [id].tsx 按字面匹配,不误删快照时跳过的大文件 d.tsx', async () => {
    writeFileSync(join(root, 'd.tsx'), Buffer.alloc(MAX_UNTRACKED_FILE_SIZE + 1));
    const cp = await createCheckpoint({ root, id: 'tool-s1-g', sessionId: 's1', trigger: 'tool' });
    writeFileSync(join(root, '[id].tsx'), 'new\n');

    await restoreCheckpoint(root, cp);

    expect([existsSync(join(root, '[id].tsx')), existsSync(join(root, 'd.tsx'))]).toEqual([
      false,
      true,
    ]);
  });

  it('快照按字面收录 [id].tsx,不连带收进本应跳过的大文件 d.tsx', async () => {
    writeFileSync(join(root, '[id].tsx'), 'page\n');
    writeFileSync(join(root, 'd.tsx'), Buffer.alloc(MAX_UNTRACKED_FILE_SIZE + 1));

    const cp = await createCheckpoint({ root, id: 'tool-s1-h', sessionId: 's1', trigger: 'tool' });

    expect(runGit(root, 'ls-tree', '--name-only', cp.worktreeTreeSha).split('\n')).toEqual([
      '[id].tsx',
      'a.txt',
    ]);
  });

  it('node_modules 不入快照,还原也不删', async () => {
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'x.js'), 'x\n');
    const cp = await createCheckpoint({ root, id: 'tool-s1-2', sessionId: 's1', trigger: 'tool' });
    writeFileSync(join(root, 'node_modules', 'y.js'), 'y\n');
    await restoreCheckpoint(root, cp);
    expect(existsSync(join(root, 'node_modules', 'x.js'))).toBe(true);
    expect(existsSync(join(root, 'node_modules', 'y.js'))).toBe(true);
  });

  it('元数据经 ref 往返完整(entryId/entryTimestamp)', async () => {
    await createCheckpoint({
      root,
      id: 'tool-s1-3',
      sessionId: 's1',
      trigger: 'tool',
      toolName: 'edit',
      entryId: 'abc123',
      entryTimestamp: 1700000000000,
    });
    const all = await loadAllCheckpoints(root, 's1');
    expect(all).toHaveLength(1);
    expect(all[0].entryId).toBe('abc123');
    expect(all[0].entryTimestamp).toBe(1700000000000);
    expect(all[0].toolName).toBe('edit');
    expect(all[0].branch).toBe('main');
  });

  it('按会话加载只打一次 for-each-ref，不逐条 cat-file', async () => {
    const msg = [
      'enso-checkpoint:tool-s1-1',
      'sessionId s1',
      'trigger tool',
      'branch main',
      `head ${'a'.repeat(40)}`,
      `index-tree ${'b'.repeat(40)}`,
      `worktree-tree ${'c'.repeat(40)}`,
      'created 2026-09-19T00:00:00.000Z',
    ].join('\n');
    const git = vi.fn(async (cmd: string) => {
      if (cmd.startsWith('for-each-ref')) {
        expect(cmd).toContain('tool-s1-');
        expect(cmd).toContain('before-restore-s1-');
        expect(cmd).not.toContain('tool-s2');
        return `refs/enso-checkpoints/tool-s1-1\0${msg}\0`;
      }
      throw new Error(`unexpected git ${cmd}`);
    });
    const host: CheckpointHost = {
      git,
      statBatch: async () => new Map(),
      mkdtemp: async () => '/tmp',
      rmrf: async () => {},
      join: (...parts) => parts.join('/'),
    };
    const all = await loadAllCheckpoints('/repo', 's1', host);
    expect(git).toHaveBeenCalledTimes(1);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: 'tool-s1-1', sessionId: 's1', trigger: 'tool' });
  });

  it('pruneStaleCheckpoints 只清过期快照,其它会话的近期快照保留', async () => {
    await createCheckpoint({ root, id: 'tool-old-1', sessionId: 'old', trigger: 'tool' });
    await createCheckpoint({ root, id: 'tool-cur-1', sessionId: 'cur', trigger: 'tool' });
    // 全部都是刚创建的:即便属于其它会话也不能删(多会话共存同一 repo)
    expect(await pruneStaleCheckpoints(root)).toBe(0);
    expect((await loadAllCheckpoints(root)).map((cp) => cp.sessionId).sort()).toEqual([
      'cur',
      'old',
    ]);
    // maxAge 为 0:全部过期,应清空
    expect(await pruneStaleCheckpoints(root, 0)).toBe(2);
    expect(await loadAllCheckpoints(root)).toHaveLength(0);
  });
});

describe('CheckpointManager', () => {
  it('每轮只打一次快照,resetTurn 后放行下一次', async () => {
    const manager = new CheckpointManager(root, 's1', () => ({
      entryId: 'e1',
      entryTimestamp: 1000,
    }));
    await manager.ensureTurnCheckpoint('write');
    await manager.ensureTurnCheckpoint('bash');
    expect(await loadAllCheckpoints(root, 's1')).toHaveLength(1);
    manager.resetTurn();
    await manager.ensureTurnCheckpoint('edit');
    expect(await loadAllCheckpoints(root, 's1')).toHaveLength(2);
  });

  it('restoreForEntry:entryId 精确命中还原该轮之前的状态,并打 before-restore 快照', async () => {
    const manager = new CheckpointManager(root, 's1', () => ({
      entryId: 'e1',
      entryTimestamp: 1000,
    }));
    await manager.ensureTurnCheckpoint('write');
    writeFileSync(join(root, 'a.txt'), 'turn-1 output\n');

    const restored = await manager.restoreForEntry('e1', 1000);
    expect(restored).toBe(true);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v1\n');
    const all = await loadAllCheckpoints(root, 's1');
    expect(all.some((cp) => cp.trigger === 'before-restore')).toBe(true);
  });

  it('restoreForEntry:目标轮没写盘时取其后最早的快照;完全无命中返回 false', async () => {
    let entry = { entryId: 'e2', entryTimestamp: 2000 };
    const manager = new CheckpointManager(root, 's1', () => entry);
    // e1(ts=1000)那轮没写盘;e2(ts=2000)那轮写了盘 → 回退到 e1 应命中 e2 的快照
    await manager.ensureTurnCheckpoint('write');
    writeFileSync(join(root, 'a.txt'), 'turn-2 output\n');

    expect(await manager.restoreForEntry('e1', 1000)).toBe(true);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v1\n');

    // 目标时间戳晚于所有快照:无命中
    entry = { entryId: 'e9', entryTimestamp: 9000 };
    expect(await manager.restoreForEntry('e9', 9000)).toBe(false);
  });

  it.each(['powershell', 'apply_patch'])(
    'withCheckpoint 包装 %s 工具时也触发本轮快照',
    async (name) => {
      const manager = new CheckpointManager(root, 's1', () => ({
        entryId: 'e1',
        entryTimestamp: 1000,
      }));
      const definition = {
        name,
        label: name,
        description: '',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [], details: undefined }),
      } as unknown as Parameters<typeof withCheckpoint>[0];
      const wrapped = withCheckpoint(definition, manager);
      await wrapped.execute('t1', {}, undefined as never, undefined as never, undefined as never);
      expect(await loadAllCheckpoints(root, 's1')).toHaveLength(1);
    }
  );

  // 真实场景:pi 默认并行执行同一条消息里的工具,模型同时 edit a、edit b 时,
  // b 抢在本轮快照之前落盘就会被当成「本轮开始前」的状态,回退+文件后 b 仍是改后内容
  it('同一条消息里并行的写盘工具都等本轮快照落定后才执行', async () => {
    writeFileSync(join(root, 'b.txt'), 'v1\n');
    runGit(root, 'add', '.');
    runGit(root, 'commit', '-q', '-m', 'add b');
    const manager = new CheckpointManager(root, 's1', () => ({
      entryId: 'e1',
      entryTimestamp: 1000,
    }));
    const editOf = (file: string) =>
      withCheckpoint(
        {
          name: 'edit',
          label: 'edit',
          description: '',
          parameters: { type: 'object', properties: {} },
          execute: async () => {
            writeFileSync(join(root, file), 'turn-1 output\n');
            return { content: [], details: undefined };
          },
        } as unknown as Parameters<typeof withCheckpoint>[0],
        manager
      );

    await Promise.all(
      ['a.txt', 'b.txt'].map((file) =>
        editOf(file).execute(file, {}, undefined as never, undefined as never, undefined as never)
      )
    );
    await manager.restoreForEntry('e1', 1000);

    expect(['a.txt', 'b.txt'].map((file) => readFileSync(join(root, file), 'utf8'))).toEqual([
      'v1\n',
      'v1\n',
    ]);
  });

  // 真实场景:文件名含 " 时快照拼出的 git add 参数被拆错而失败,该文件不删就每轮都失败,
  // 连续 3 次后会话静默停用快照
  it.skipIf(process.platform === 'win32')(
    '工作树里有含引号文件名的未跟踪文件时,回退照常还原',
    async () => {
      writeFileSync(join(root, 'a"b.txt'), 'v1\n');
      const manager = new CheckpointManager(root, 's1', () => ({
        entryId: 'e1',
        entryTimestamp: 1000,
      }));
      await manager.ensureTurnCheckpoint('write');
      writeFileSync(join(root, 'a"b.txt'), 'turn-1 output\n');

      await manager.restoreForEntry('e1', 1000);

      expect(readFileSync(join(root, 'a"b.txt'), 'utf8')).toBe('v1\n');
    }
  );

  // 背景:快照失败只计数、3 次后静默停用,正是 checkpoint-cross-session-wipe 记录的
  // 「静默降级掩盖故障」;git 仓库里打不出快照属于「该有而没有」,至少要留下原因
  it('git 仓库里快照失败时留一行带原因的日志', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const host: CheckpointHost = {
        git: async (cmd) => {
          if (cmd === 'rev-parse --show-toplevel') return '/repo';
          throw new Error('fatal: index file corrupt');
        },
        statBatch: async () => new Map(),
        mkdtemp: async () => '/tmp/enso-checkpoint-x',
        rmrf: async () => {},
        join: (...parts) => parts.join('/'),
      };
      const manager = new CheckpointManager('/repo', 's1', () => ({}), host);

      await manager.ensureTurnCheckpoint('write');

      expect(warn.mock.calls.flat().join(' ')).toContain('fatal: index file corrupt');
    } finally {
      warn.mockRestore();
    }
  });

  it('非 git 目录静默降级,不抛错', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'enso-cp-plain-'));
    try {
      const manager = new CheckpointManager(plain, 's1', () => ({}));
      await expect(manager.ensureTurnCheckpoint('write')).resolves.toBeUndefined();
      expect(await manager.restoreForEntry('e1', 1000)).toBe(false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
