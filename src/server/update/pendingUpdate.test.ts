import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearPendingUpdate,
  markUpdateReady,
  readPendingUpdate,
  resolveUpdateBoot,
  writePendingUpdate,
} from './pendingUpdate';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'enso-pending-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (data: unknown) =>
  writeFileSync(path.join(dir, 'pending-update.json'), JSON.stringify(data));

describe('pending-update 健康检查与回滚', () => {
  it('写入与读取往返', () => {
    writePendingUpdate(dir, { from: '0.3.14', to: '0.3.15-beta.231', at: 1 });
    expect(readPendingUpdate(dir)).toEqual({
      from: '0.3.14',
      to: '0.3.15-beta.231',
      at: 1,
      boots: 0,
    });
  });

  it('坏文件与不完整字段按没有处理', () => {
    write('not json');
    expect(readPendingUpdate(dir)).toBeNull();
    write({ from: 1, to: '0.3.15' });
    expect(readPendingUpdate(dir)).toBeNull();
  });

  it('起来的就是目标版本：首次与第二次启动计为 booting', () => {
    writePendingUpdate(dir, { from: '0.3.14', to: '0.3.15', at: 1 });
    expect(resolveUpdateBoot(dir, '0.3.15')).toEqual({
      kind: 'booting',
      from: '0.3.14',
      to: '0.3.15',
      boots: 1,
    });
    expect(resolveUpdateBoot(dir, '0.3.15')).toMatchObject({ kind: 'booting', boots: 2 });
  });

  it('新版本反复崩溃：计满次数后要求回滚到旧版本', () => {
    writePendingUpdate(dir, { from: '0.3.14', to: '0.3.15', at: 1 });
    expect(resolveUpdateBoot(dir, '0.3.15').kind).toBe('booting');
    expect(resolveUpdateBoot(dir, '0.3.15').kind).toBe('booting');
    const third = resolveUpdateBoot(dir, '0.3.15');
    expect(third).toEqual({ kind: 'rollback', from: '0.3.14', to: '0.3.15' });
  });

  it('版本与标记对不上（手动换过版本/半安装）：按过期清理，不回滚', () => {
    writePendingUpdate(dir, { from: '0.3.14', to: '0.3.15', at: 1 });
    expect(resolveUpdateBoot(dir, '0.3.16')).toEqual({ kind: 'stale' });
    expect(readPendingUpdate(dir)).toBeNull();
  });

  it('没有标记时无需处理', () => {
    expect(resolveUpdateBoot(dir, '0.3.15')).toEqual({ kind: 'none' });
  });

  it('markUpdateReady 在目标版本仍在跑时清除标记', () => {
    writePendingUpdate(dir, { from: '0.3.14', to: '0.3.15', at: 1 });
    resolveUpdateBoot(dir, '0.3.15');
    markUpdateReady(dir, '0.3.15');
    expect(readPendingUpdate(dir)).toBeNull();
  });

  it('markUpdateReady 不清除已被替换的标记', () => {
    writePendingUpdate(dir, { from: '0.3.14', to: '0.3.15', at: 1 });
    writePendingUpdate(dir, { from: '0.3.15', to: '0.3.16', at: 2 });
    markUpdateReady(dir, '0.3.15');
    expect(readPendingUpdate(dir)).toEqual({ from: '0.3.15', to: '0.3.16', at: 2, boots: 0 });
  });

  it('clearPendingUpdate 幂等', () => {
    clearPendingUpdate(dir);
    writePendingUpdate(dir, { from: '0.3.14', to: '0.3.15', at: 1 });
    clearPendingUpdate(dir);
    expect(readPendingUpdate(dir)).toBeNull();
  });
});
