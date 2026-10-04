import { describe, expect, it } from 'vitest';
import { OauthAccountPool } from './oauthAccountPool';

const keys = ['openai-codex', 'openai-codex#2', 'openai-codex#3'];
describe('Main ChatGPT 顺序池', () => {
  it('并发父子对旧账号的重复故障只推进一次，新轮也不退回锚点', () => {
    const pool = new OauthAccountPool(() => 1000);
    expect(pool.select('pool', keys, keys)).toBe(keys[0]);
    expect(
      pool.select('pool', keys, keys, { accountKey: keys[0], reason: 'quota-exhausted' })
    ).toBe(keys[1]);
    expect(pool.select('pool', keys, keys, { accountKey: keys[0], reason: 'login-invalid' })).toBe(
      keys[1]
    );
    expect(pool.select('pool', keys, keys)).toBe(keys[1]);
  });
  it('过期记录尚未清理时新额度故障必须重新封锁，不能立即选回该账号', () => {
    let now = 1000;
    const pool = new OauthAccountPool(() => now);
    pool.select('pool', keys, keys, {
      accountKey: keys[0],
      reason: 'quota-exhausted',
      resetAt: 2000,
    });
    now = 3000;
    expect(
      pool.select('pool', keys, [keys[0]], {
        accountKey: keys[0],
        reason: 'quota-exhausted',
        resetAt: 4000,
      })
    ).toBeUndefined();
    now = 4001;
    expect(pool.select('pool', keys, [keys[0]])).toBe(keys[0]);
  });
  it('无reset证据有限冷却，全部账号失效返回明确不可选状态', () => {
    let now = 1000;
    const pool = new OauthAccountPool(() => now);
    for (const accountKey of keys)
      pool.select('pool', keys, keys, { accountKey, reason: 'quota-exhausted' });
    expect(pool.select('pool', keys, keys)).toBeUndefined();
    now += 300_001;
    expect(pool.select('pool', keys, keys)).toBeDefined();
  });
  it('并发失败提供更长reset窗口时合并窗口，但不推进正在使用的新账号', () => {
    let now = 1000;
    const pool = new OauthAccountPool(() => now);
    pool.select('pool', keys, keys, {
      accountKey: keys[0],
      reason: 'quota-exhausted',
      resetAt: 2000,
    });
    expect(
      pool.select('pool', keys, keys, {
        accountKey: keys[0],
        reason: 'quota-exhausted',
        resetAt: 5000,
      })
    ).toBe(keys[1]);
    now = 3000;
    expect(pool.select('pool', keys, [keys[0]])).toBeUndefined();
  });
  it('停用和登出的成员不会被选择，池游标按ID隔离而额度状态共用', () => {
    const pool = new OauthAccountPool(() => 1000);
    expect(pool.select('a', keys, [keys[2]])).toBe(keys[2]);
    expect(pool.select('b', keys, keys, { accountKey: keys[0], reason: 'login-invalid' })).toBe(
      keys[1]
    );
    expect(pool.select('a', keys, keys)).toBe(keys[2]);
  });
});
