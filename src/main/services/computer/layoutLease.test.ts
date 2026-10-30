import { describe, expect, it } from 'vitest';
import { EnglishLayoutLease, type LayoutDeps } from './layoutLease';

function fake(start = 'pinyin') {
  const log: string[] = [];
  const state = { current: start };
  const deps: LayoutDeps<string> = {
    current: () => state.current,
    english: () => 'abc',
    id: (source) => source,
    select: (source) => {
      log.push(`select ${source}`);
      state.current = source;
      return true;
    },
    release: () => {},
    sleep: async () => {},
  };
  return { deps, log, state };
}

describe('EnglishLayoutLease', () => {
  it('首个使用者切到英文，最后一个使用者结束才恢复', async () => {
    const { deps, log, state } = fake();
    const lease = new EnglishLayoutLease(deps);
    await lease.acquire();
    await lease.acquire();
    expect(log).toEqual(['select abc']);
    await lease.release();
    expect(state.current).toBe('abc');
    await lease.release();
    expect(log).toEqual(['select abc', 'select pinyin']);
  });

  it('第二个使用者在恢复前进来：不把英文当成原输入源', async () => {
    const { deps, log, state } = fake();
    let resumeSleep: () => void = () => {};
    deps.sleep = () =>
      new Promise<void>((resolve) => {
        resumeSleep = resolve;
      });
    const lease = new EnglishLayoutLease(deps);
    deps.sleep = async () => {};
    await lease.acquire();
    deps.sleep = () =>
      new Promise<void>((resolve) => {
        resumeSleep = resolve;
      });
    const releasing = lease.release();
    deps.sleep = async () => {};
    await lease.acquire();
    resumeSleep();
    await releasing;
    expect(state.current).toBe('abc');
    await lease.release();
    expect(state.current).toBe('pinyin');
    expect(log.filter((line) => line === 'select pinyin')).toHaveLength(1);
  });

  it('本来就是英文布局：不切换也不恢复', async () => {
    const { deps, log } = fake('abc');
    const lease = new EnglishLayoutLease(deps);
    await lease.acquire();
    await lease.release();
    expect(log).toEqual([]);
  });

  it('多余的 release 不会把计数减成负数', async () => {
    const { deps, log } = fake();
    const lease = new EnglishLayoutLease(deps);
    await lease.release();
    await lease.acquire();
    await lease.release();
    expect(log).toEqual(['select abc', 'select pinyin']);
  });
});
