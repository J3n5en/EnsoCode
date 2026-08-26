import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCheckpoint, loadAllCheckpoints, pruneOldSessions, restoreCheckpoint } from './core';
import { CheckpointManager } from './manager';

const runGit = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'enso-cp-test-'));
  runGit(root, 'init', '-q', '-b', 'main');
  runGit(root, 'config', 'user.name', 'test');
  runGit(root, 'config', 'user.email', 'test@test');
  writeFileSync(join(root, 'a.txt'), 'v1\n');
  runGit(root, 'add', '.');
  runGit(root, 'commit', '-q', '-m', 'init');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
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

  it('pruneOldSessions 清掉其它会话的 refs,保留当前会话', async () => {
    await createCheckpoint({ root, id: 'tool-old-1', sessionId: 'old', trigger: 'tool' });
    await createCheckpoint({ root, id: 'tool-cur-1', sessionId: 'cur', trigger: 'tool' });
    await pruneOldSessions(root, 'cur');
    const remaining = await loadAllCheckpoints(root);
    expect(remaining.map((cp) => cp.sessionId)).toEqual(['cur']);
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
