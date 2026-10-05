import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { OauthAccountUsage } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OauthQuotaCoordinator } from './oauthQuotaCoordinator';

const keys = ['openai-codex', 'openai-codex#2', 'openai-codex#3', 'openai-codex#4'];
const identityA = 'a'.repeat(64);
const identityB = 'b'.repeat(64);
let dir: string;
let file: string;
let now: number;
let identities: Map<string, string>;
let answers: Map<string, OauthAccountUsage>;
let query: ReturnType<typeof vi.fn<(key: string) => Promise<OauthAccountUsage>>>;
const usage = (key: string, percent: number, resetsAt = now + 100_000): OauthAccountUsage => ({
  key,
  windows: [{ label: 'primary', usedPercent: percent, resetsAt }],
});
const create = () =>
  new OauthQuotaCoordinator({
    file,
    now: () => now,
    identity: async (key) => identities.get(key),
    query,
  });
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'enso-quota-'));
  file = path.join(dir, 'quota.json');
  now = 1_700_000_000_000;
  identities = new Map(keys.map((key) => [key, identityA]));
  answers = new Map(keys.map((key) => [key, usage(key, 20)]));
  query = vi.fn(async (key) => answers.get(key) ?? { key, windows: [], error: 'offline' });
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('Main 额度权威协调器', () => {
  it.each([2, 3])('前%d个已耗尽直接选下一个，之后不重复探测或试发模型请求', async (count) => {
    for (const key of keys.slice(0, count)) answers.set(key, usage(key, 100));
    const quota = create();
    expect(await quota.select('pool', keys, keys)).toMatchObject({ accountKey: keys[count] });
    expect(query.mock.calls.map(([key]) => key)).toEqual(keys.slice(0, count + 1));
    query.mockClear();
    expect(await quota.select('pool', keys, keys)).toMatchObject({ accountKey: keys[count] });
    expect(query).not.toHaveBeenCalled();
  });
  it('全有额度时保持配置顺序和游标，只查询当前，不查其它账号', async () => {
    const quota = create();
    expect(await quota.select('p', keys, keys)).toMatchObject({ accountKey: keys[0] });
    expect(await quota.select('p', keys, keys)).toMatchObject({ accountKey: keys[0] });
    expect(query.mock.calls.map(([key]) => key)).toEqual([keys[0]]);
    expect(
      await quota.select('p', keys, keys, {
        accountKey: keys[0],
        reason: 'quota-exhausted',
        resetAt: now + 100_000,
      })
    ).toMatchObject({ accountKey: keys[1] });
    expect(await quota.select('p', keys, keys)).toMatchObject({ accountKey: keys[1] });
  });
  it('UI额度查询和选号复用同一缓存，缓存过期只查当前', async () => {
    const quota = create();
    answers.set(keys[0], usage(keys[0], 100));
    await quota.getUsage(keys[0]);
    expect(await quota.select('p', keys, keys)).toMatchObject({ accountKey: keys[1] });
    expect(query).toHaveBeenCalledTimes(2);
    now += 60_001;
    await quota.select('p', keys, keys);
    expect(query.mock.calls.map(([key]) => key)).toEqual([keys[0], keys[1], keys[1]]);
  });
  it('a恢复也不打断当前b，直到b耗尽才按顺序继续', async () => {
    const quota = create();
    answers.set(keys[0], usage(keys[0], 100, now + 1000));
    expect(await quota.select('p', keys, keys)).toMatchObject({ accountKey: keys[1] });
    now += 1001;
    answers.set(keys[0], usage(keys[0], 0));
    await quota.getUsage(keys[0]);
    expect(await quota.select('p', keys, keys)).toMatchObject({ accountKey: keys[1] });
    expect(
      await quota.select('p', keys, keys, {
        accountKey: keys[1],
        reason: 'quota-exhausted',
        resetAt: now + 1000,
      })
    ).toMatchObject({ accountKey: keys[2] });
  });
  it('耗尽落本地sidecar跨重启跳过，不保存身份明文或其它展示字段', async () => {
    answers.set(keys[0], usage(keys[0], 100));
    await create().select('p', keys, keys);
    const disk = readFileSync(file, 'utf8');
    expect(disk).not.toContain('primary');
    expect(disk).not.toContain('email');
    expect(disk).not.toContain('token');
    query.mockClear();
    expect(await create().select('p2', keys, keys)).toMatchObject({ accountKey: keys[1] });
    expect(query.mock.calls.map(([key]) => key)).toEqual([keys[1]]);
  });
  it('reset到期必须重新查询确认，不凭时间推断恢复', async () => {
    answers.set(keys[0], usage(keys[0], 100, now + 1000));
    const quota = create();
    await quota.getUsage(keys[0]);
    now += 1001;
    answers.set(keys[0], usage(keys[0], 100));
    expect(await quota.select('new', keys, keys)).toMatchObject({ accountKey: keys[1] });
    expect(query.mock.calls.filter(([key]) => key === keys[0])).toHaveLength(2);
    now += 100_001;
    answers.set(keys[0], usage(keys[0], 0));
    expect(await quota.select('another', keys, keys)).toMatchObject({ accountKey: keys[0] });
  });
  it('多窗口任一个耗尽就跳过，最近reset后复查仍耗尽，所有窗口恢复才可用', async () => {
    const quota = create();
    answers.set(keys[0], {
      key: keys[0],
      windows: [
        { label: '5h', usedPercent: 100, resetsAt: now + 1000 },
        { label: '7d', usedPercent: 100, resetsAt: now + 10_000 },
      ],
    });
    await quota.getUsage(keys[0]);
    now += 1001;
    answers.set(keys[0], {
      key: keys[0],
      windows: [
        { label: '5h', usedPercent: 10, resetsAt: now + 1000 },
        { label: '7d', usedPercent: 100, resetsAt: now + 8999 },
      ],
    });
    expect(await quota.select('p', keys, keys)).toMatchObject({ accountKey: keys[1] });
    expect(query.mock.calls.filter(([key]) => key === keys[0])).toHaveLength(2);
    now += 9000;
    answers.set(keys[0], usage(keys[0], 0));
    expect(await quota.select('new', keys, keys)).toMatchObject({ accountKey: keys[0] });
  });
  it('全耗尽时提示各账号完整恢复时间中的最早值', async () => {
    for (const [index, key] of keys.entries())
      answers.set(key, usage(key, 100, now + (index + 1) * 1000));
    const result = await create().select('p', keys, keys);
    expect(result.accountKey).toBeUndefined();
    expect(result.error).toContain(new Date(now + 1000).toISOString());
  });
  it('多窗口重置后查询失败仍保留另一个未过期耗尽窗口', async () => {
    const quota = create();
    answers.set(keys[0], {
      key: keys[0],
      windows: [
        { label: 'short', usedPercent: 100, resetsAt: now + 1000 },
        { label: 'long', usedPercent: 100, resetsAt: now + 10_000 },
      ],
    });
    await quota.getUsage(keys[0]);
    now += 1001;
    answers.delete(keys[0]);
    expect(await quota.select('p', keys, keys)).toMatchObject({ accountKey: keys[1] });
    expect(query.mock.calls.filter(([key]) => key === keys[0])).toHaveLength(2);
    now += 9000;
    expect(await quota.select('unknown', keys, [keys[0]])).toMatchObject({
      accountKey: keys[0],
      warning: expect.any(String),
    });
  });
  it('另一个窗口数据无效不能掩盖有效窗口明确耗尽', async () => {
    answers.set(keys[0], {
      key: keys[0],
      windows: [
        { label: 'quota', usedPercent: 100, resetsAt: now + 1000 },
        { label: 'bad', usedPercent: Number.NaN },
      ],
    });
    expect(await create().select('p', keys, keys)).toMatchObject({ accountKey: keys[1] });
    expect(await create().select('p', keys, [keys[0]])).not.toHaveProperty('accountKey');
  });
  it.each(['empty', 'error', 'throw', 'invalid', 'expired'])(
    '未知%s不认耗尽，不永久排除',
    async (kind) => {
      const quota = create();
      for (const key of keys.slice(1)) answers.delete(key);
      if (kind === 'empty') answers.set(keys[0], { key: keys[0], windows: [] });
      if (kind === 'error') answers.delete(keys[0]);
      if (kind === 'throw') query.mockRejectedValueOnce(new Error('offline'));
      if (kind === 'invalid') answers.set(keys[0], usage(keys[0], Number.NaN));
      if (kind === 'expired') answers.set(keys[0], usage(keys[0], 100, now - 1));
      expect(await quota.select('p', keys, keys)).toMatchObject({ accountKey: keys[0] });
      expect(query).toHaveBeenCalledTimes(4);
      await quota.select('p', keys, keys);
      expect(query).toHaveBeenCalledTimes(4);
    }
  );
  it('未知a查询失败而b确认可用时优先b，不对a试发模型请求', async () => {
    answers.delete(keys[0]);
    expect(await create().select('p', keys, keys)).toMatchObject({ accountKey: keys[1] });
    expect(query.mock.calls.map(([key]) => key)).toEqual(keys.slice(0, 2));
  });
  describe('选号查询总等待预算', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    });
    it('四账号每次查询10秒时总等待不超过20秒，预算到时不启动剩余网络', async () => {
      query.mockImplementation(
        (key) =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ key, windows: [], error: 'offline' }), 10_000)
          )
      );
      let result: Awaited<ReturnType<OauthQuotaCoordinator['select']>> | undefined;
      void create()
        .select('p', keys, keys)
        .then((value) => {
          result = value;
        });
      await vi.advanceTimersByTimeAsync(19_999);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toMatchObject({ accountKey: keys[0], warning: expect.any(String) });
      expect(result).not.toHaveProperty('error');
      expect(query.mock.calls.map(([key]) => key)).toEqual(keys.slice(0, 2));
      expect(vi.getTimerCount()).toBe(0);
    });
    it('首个查询挂起到预算耗尽后仍扫描缓存健康和封锁，不试发未知或封锁账号', async () => {
      const quota = create();
      answers.set(keys[1], usage(keys[1], 100));
      await quota.getUsage(keys[1]);
      await quota.getUsage(keys[3]);
      query.mockClear();
      query.mockImplementation(() => new Promise(() => {}));
      let result: Awaited<ReturnType<OauthQuotaCoordinator['select']>> | undefined;
      void quota.select('p', keys, keys).then((value) => {
        result = value;
      });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(result).toEqual({ accountKey: keys[3] });
      expect(query.mock.calls.map(([key]) => key)).toEqual([keys[0]]);
      expect(vi.getTimerCount()).toBe(0);
    });
    it('挂起查询到时仅有限降级为unknown，晚到健康结果正常缓存而不把超时当耗尽', async () => {
      const quota = create();
      const pending = Promise.withResolvers<OauthAccountUsage>();
      query.mockImplementationOnce(() => pending.promise);
      let result: Awaited<ReturnType<OauthQuotaCoordinator['select']>> | undefined;
      void quota.select('p', keys, keys).then((value) => {
        result = value;
      });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(result).toMatchObject({ accountKey: keys[0], warning: expect.any(String) });
      expect(query.mock.calls.map(([key]) => key)).toEqual([keys[0]]);
      pending.resolve(usage(keys[0], 10));
      await vi.advanceTimersByTimeAsync(0);
      expect(await quota.select('later', keys, keys)).toEqual({ accountKey: keys[0] });
      expect(query).toHaveBeenCalledTimes(1);
    });
    it('选号超时后旧查询拒绝仍被处理，保留unknown错误缓存而不新增封锁', async () => {
      const quota = create();
      const pending = Promise.withResolvers<OauthAccountUsage>();
      query.mockImplementationOnce(() => pending.promise);
      let result: Awaited<ReturnType<OauthQuotaCoordinator['select']>> | undefined;
      void quota.select('p', keys, [keys[0]]).then((value) => {
        result = value;
      });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(result).toMatchObject({ accountKey: keys[0], warning: expect.any(String) });
      pending.reject(new Error('late network failure'));
      await vi.advanceTimersByTimeAsync(0);
      expect(await quota.select('later', keys, [keys[0]])).toMatchObject({
        accountKey: keys[0],
        warning: expect.any(String),
      });
      expect(query).toHaveBeenCalledTimes(1);
    });
    it('预算后的旧查询不越过身份代际封锁重登账号', async () => {
      const quota = create();
      const pending = Promise.withResolvers<OauthAccountUsage>();
      query.mockImplementationOnce(() => pending.promise);
      let result: Awaited<ReturnType<OauthQuotaCoordinator['select']>> | undefined;
      void quota.select('p', keys, [keys[0]]).then((value) => {
        result = value;
      });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(result).toMatchObject({ accountKey: keys[0], warning: expect.any(String) });
      quota.invalidate(keys[0]);
      identities.set(keys[0], identityB);
      await quota.getUsage(keys[0]);
      pending.resolve(usage(keys[0], 100));
      await vi.advanceTimersByTimeAsync(0);
      expect(await quota.select('new', keys, keys)).toEqual({ accountKey: keys[0] });
      expect(query).toHaveBeenCalledTimes(2);
    });
    it('预算后新增硬失败提升查询代际，迟到健康结果不能清除新封锁', async () => {
      const quota = create();
      const pending = Promise.withResolvers<OauthAccountUsage>();
      query.mockImplementationOnce(() => pending.promise);
      const oldUi = quota.getUsage(keys[0]);
      let result: Awaited<ReturnType<OauthQuotaCoordinator['select']>> | undefined;
      void quota.select('p', keys, keys).then((value) => {
        result = value;
      });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(result).toMatchObject({ accountKey: keys[0], warning: expect.any(String) });
      expect(
        await quota.select('p', keys, keys, {
          accountKey: keys[0],
          reason: 'quota-exhausted',
          resetAt: now + 100_000,
        })
      ).toEqual({ accountKey: keys[1] });
      pending.resolve(usage(keys[0], 0));
      expect(await oldUi).toMatchObject({ windows: [], error: expect.any(String) });
      await vi.advanceTimersByTimeAsync(0);
      expect(await quota.select('later', keys, keys)).toEqual({ accountKey: keys[1] });
      expect(query.mock.calls.map(([key]) => key)).toEqual(keys.slice(0, 2));
    });
  });
  it('额度网络失败保留有效硬封锁，过期后失败不会永久封锁', async () => {
    const quota = create();
    await quota.select('p', keys, keys, {
      accountKey: keys[0],
      reason: 'quota-exhausted',
      resetAt: now + 1000,
    });
    answers.delete(keys[0]);
    await quota.getUsage(keys[0]);
    expect(await quota.select('other', keys, keys)).toMatchObject({ accountKey: keys[1] });
    now += 1001;
    expect(await quota.select('new', keys, [keys[0]])).toMatchObject({ accountKey: keys[0] });
  });
  it('并发UI和父子选号合并额度请求', async () => {
    const quota = create();
    const results = await Promise.all([
      quota.getUsage(keys[0]),
      quota.select('a', keys, keys),
      quota.select('b', keys, keys),
    ]);
    expect(results.slice(1)).toEqual([{ accountKey: keys[0] }, { accountKey: keys[0] }]);
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('晚到健康额度及UI健康查询不能清仍有效硬失败封锁', async () => {
    const quota = create();
    const pending = Promise.withResolvers<OauthAccountUsage>();
    query.mockImplementationOnce(() => pending.promise);
    const ui = quota.getUsage(keys[0]);
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    expect(
      await quota.select('p', keys, keys, {
        accountKey: keys[0],
        reason: 'quota-exhausted',
        resetAt: now + 1000,
      })
    ).toMatchObject({ accountKey: keys[1] });
    pending.resolve(usage(keys[0], 0));
    await ui;
    await quota.getUsage(keys[0]);
    expect(await quota.select('other', keys, keys)).toMatchObject({ accountKey: keys[1] });
    expect(await create().select('restart', keys, keys)).toMatchObject({ accountKey: keys[1] });
    now += 1001;
    expect(await quota.select('reset', keys, keys)).toMatchObject({ accountKey: keys[0] });
  });
  it('同时耗尽两个账号的sidecar保留两个记录，reconcile清理真实删除的账号', async () => {
    const quota = create();
    for (const key of keys.slice(0, 2)) answers.set(key, usage(key, 100));
    await Promise.all(keys.slice(0, 2).map((key) => quota.getUsage(key)));
    query.mockClear();
    expect(await create().select('restart', keys, keys)).toMatchObject({ accountKey: keys[2] });
    expect(query.mock.calls.map(([key]) => key)).toEqual([keys[2]]);
    quota.reconcileKeys(new Set(keys.slice(1)));
    expect(readFileSync(file, 'utf8')).not.toContain(`"key":"${keys[0]}"`);
  });
  it('删除、同key换身份及显式登出失效均不继承旧封锁', async () => {
    const quota = create();
    answers.set(keys[0], usage(keys[0], 100));
    await quota.getUsage(keys[0]);
    identities.delete(keys[0]);
    expect(await quota.select('deleted', keys, keys)).toMatchObject({ accountKey: keys[1] });
    identities.set(keys[0], identityB);
    answers.set(keys[0], usage(keys[0], 20));
    expect(await quota.select('changed', keys, keys)).toMatchObject({ accountKey: keys[0] });
    answers.set(keys[0], usage(keys[0], 100));
    quota.invalidate(keys[0]);
    await quota.getUsage(keys[0]);
    quota.invalidate(keys[0]);
    answers.set(keys[0], usage(keys[0], 20));
    expect(await quota.select('login', keys, keys)).toMatchObject({ accountKey: keys[0] });
  });
  it('挂起旧查询后换身份，新身份不会被旧结果封锁', async () => {
    const quota = create();
    const pending = Promise.withResolvers<OauthAccountUsage>();
    query.mockImplementationOnce(() => pending.promise);
    const old = quota.getUsage(keys[0]);
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    quota.invalidate(keys[0]);
    identities.set(keys[0], identityB);
    expect(await quota.select('new', keys, keys)).toMatchObject({ accountKey: keys[0] });
    pending.resolve(usage(keys[0], 100));
    expect(await old).toMatchObject({ windows: [], error: expect.any(String) });
    expect(await quota.select('later', keys, keys)).toMatchObject({ accountKey: keys[0] });
  });
  it('硬失败前的健康查询跨reset完成不构成恢复证据，必须reset后新查', async () => {
    const quota = create();
    const pending = Promise.withResolvers<OauthAccountUsage>();
    query.mockImplementationOnce(() => pending.promise);
    const old = quota.getUsage(keys[0]);
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    await quota.select('p', keys, keys, {
      accountKey: keys[0],
      reason: 'quota-exhausted',
      resetAt: now + 1000,
    });
    now += 1001;
    pending.resolve(usage(keys[0], 0));
    expect(await old).toMatchObject({ windows: [], error: expect.any(String) });
    answers.set(keys[0], usage(keys[0], 100));
    expect(await quota.select('new', keys, keys)).toMatchObject({ accountKey: keys[1] });
    expect(query.mock.calls.filter(([key]) => key === keys[0])).toHaveLength(2);
  });
  it('硬失败后的UI查询在reset前发起跨reset完成，也必须reset后新查', async () => {
    const quota = create();
    await quota.select('p', keys, keys, {
      accountKey: keys[0],
      reason: 'quota-exhausted',
      resetAt: now + 1000,
    });
    now += 500;
    const pending = Promise.withResolvers<OauthAccountUsage>();
    query.mockImplementationOnce(() => pending.promise);
    const old = quota.getUsage(keys[0]);
    await vi.waitFor(() =>
      expect(query.mock.calls.filter(([key]) => key === keys[0])).toHaveLength(1)
    );
    now += 501;
    pending.resolve(usage(keys[0], 0));
    expect(await old).toMatchObject({ windows: [], error: expect.any(String) });
    answers.set(keys[0], usage(keys[0], 100));
    expect(await quota.select('new', keys, keys)).toMatchObject({ accountKey: keys[1] });
    expect(query.mock.calls.filter(([key]) => key === keys[0])).toHaveLength(2);
  });
  it('选号receipt绑定pool、key、身份及凭证代际，凭证失效后旧票不可用', async () => {
    const quota = create();
    await quota.select('p', keys, keys);
    const selectionReceipt = await quota.issueSelectionReceipt('p', keys[0]);
    const failure = { accountKey: keys[0], reason: 'quota-exhausted' as const, selectionReceipt };
    expect(await quota.validateFailure('p', failure)).toEqual(failure);
    expect(await quota.validateFailure('wrong', failure)).toBeUndefined();
    expect(await quota.validateFailure('p', { ...failure, accountKey: keys[1] })).toBeUndefined();
    identities.set(keys[0], identityB);
    expect(await quota.validateFailure('p', failure)).toBeUndefined();
    const newReceipt = await quota.issueSelectionReceipt('p', keys[0]);
    quota.invalidate(keys[0]);
    expect(
      await quota.validateFailure('p', { ...failure, selectionReceipt: newReceipt })
    ).toBeUndefined();
  });
  it('硬失败只提升查询代际，同身份并发模型票仍可延长reset证据', async () => {
    const quota = create();
    await quota.select('p', keys, keys);
    const first = await quota.issueSelectionReceipt('p', keys[0]);
    const second = await quota.issueSelectionReceipt('p', keys[0]);
    const failure = {
      accountKey: keys[0],
      reason: 'quota-exhausted' as const,
      resetAt: now + 1000,
      selectionReceipt: first,
    };
    await quota.select('p', keys, keys, await quota.validateFailure('p', failure));
    const delayed = { ...failure, resetAt: now + 10_000, selectionReceipt: second };
    expect(await quota.validateFailure('p', delayed)).toEqual(delayed);
    await quota.select('p', keys, keys, await quota.validateFailure('p', delayed));
    now += 1001;
    expect(await quota.select('new', keys, [keys[0]])).not.toHaveProperty('accountKey');
  });
  it('选号票数量和TTL有界，并发签票不会无限增长', async () => {
    const quota = create();
    const receipts = await Promise.all(
      Array.from({ length: 4097 }, () => quota.issueSelectionReceipt('p', keys[0]))
    );
    const failure = { accountKey: keys[0], reason: 'login-invalid' as const };
    expect(
      await quota.validateFailure('p', { ...failure, selectionReceipt: receipts[0] })
    ).toBeUndefined();
    expect(
      await quota.validateFailure('p', { ...failure, selectionReceipt: receipts.at(-1) })
    ).toBeDefined();
    now += 24 * 3_600_000;
    expect(
      await quota.validateFailure('p', { ...failure, selectionReceipt: receipts.at(-1) })
    ).toBeUndefined();
  });
  it('异步签票期间logout，不能给旧身份签出有效票', async () => {
    const pending = Promise.withResolvers<string | undefined>();
    const quota = new OauthQuotaCoordinator({
      file,
      now: () => now,
      identity: () => pending.promise,
      query,
    });
    const receipt = quota.issueSelectionReceipt('p', keys[0]);
    quota.invalidate(keys[0]);
    pending.resolve(identityA);
    expect(await receipt).toBeUndefined();
  });
  it('receipt验证后写硬失败前凭证失效，旧失败仍不能重新封锁同key', async () => {
    const quota = create();
    await quota.select('p', keys, keys);
    const selectionReceipt = await quota.issueSelectionReceipt('p', keys[0]);
    const verified = await quota.validateFailure('p', {
      accountKey: keys[0],
      reason: 'quota-exhausted',
      selectionReceipt,
    });
    quota.invalidate(keys[0]);
    expect(await quota.select('p', keys, keys, verified)).toMatchObject({ accountKey: keys[0] });
  });
  it.each([
    '{broken',
    'null',
    '[]',
    '{"version":1,"records":[{"key":"../../evil","identity":"bad","checkedAt":null,"hardUntil":1e300}]}',
  ])('坏sidecar %s不影响可用账号', async (raw) => {
    writeFileSync(file, raw);
    expect(await create().select('p', keys, keys)).toMatchObject({ accountKey: keys[0] });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    (now: number) => now + 31 * 86_400_000,
    (now: number) => now - 31 * 86_400_000,
  ])('合法key也不能用非法或无界时间永久封锁', async (raw) => {
    const timestamp = typeof raw === 'function' ? raw(now) : raw;
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        records: [
          {
            key: keys[0],
            identity: identityA,
            checkedAt: timestamp,
            windows: [{ usedPercent: 100, resetsAt: now + 1000 }],
            hardUntil: now + 1000,
          },
        ],
      })
    );
    expect(await create().select('p', keys, keys)).toMatchObject({ accountKey: keys[0] });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('硬封锁截止也必须相对观测时间有界，不能用旧记录续成超长封锁', async () => {
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        records: [
          {
            key: keys[0],
            identity: identityA,
            checkedAt: now - 10 * 86_400_000,
            windows: [],
            hardUntil: now + 25 * 86_400_000,
          },
        ],
      })
    );
    expect(await create().select('p', keys, keys)).toMatchObject({ accountKey: keys[0] });
  });
});
