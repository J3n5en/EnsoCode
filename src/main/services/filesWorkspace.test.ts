import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RefCountWatchers, resolveUnderCwd } from './filesWorkspace';

describe('resolveUnderCwd', () => {
  const cwd = path.resolve('/repo');

  it('空 rel 落在 cwd', () => {
    expect(resolveUnderCwd(cwd, '')).toBe(cwd);
    expect(resolveUnderCwd(cwd, '.')).toBe(cwd);
  });

  it('相对路径 join', () => {
    expect(resolveUnderCwd(cwd, 'src/a.ts')).toBe(path.resolve('/repo/src/a.ts'));
  });

  it('拒绝 .. 逃出', () => {
    expect(resolveUnderCwd(cwd, '../secret')).toBeNull();
    expect(resolveUnderCwd(cwd, 'src/../../etc/passwd')).toBeNull();
  });

  it('拒绝绝对路径逃出', () => {
    expect(resolveUnderCwd(cwd, '/etc/passwd')).toBeNull();
  });
});

describe('RefCountWatchers', () => {
  it('同 key 第二次 acquire 不重复 start，release 到 0 才 stop', () => {
    let starts = 0;
    let stops = 0;
    const table = new RefCountWatchers();
    const start = () => {
      starts += 1;
      return () => {
        stops += 1;
      };
    };
    table.acquire('a', start);
    table.acquire('a', start);
    expect(starts).toBe(1);
    expect(table.size).toBe(1);
    table.release('a');
    expect(stops).toBe(0);
    table.release('a');
    expect(stops).toBe(1);
    expect(table.size).toBe(0);
  });

  it('releaseAll 按前缀清掉剩余 watch', () => {
    let stops = 0;
    const table = new RefCountWatchers();
    const start = () => () => {
      stops += 1;
    };
    table.acquire('c1:foo.ts', start);
    table.acquire('c1:bar.ts', start);
    table.acquire('c2:z.ts', start);
    table.releaseAll((key) => key.startsWith('c1:'));
    expect(stops).toBe(2);
    expect(table.size).toBe(1);
  });
});
