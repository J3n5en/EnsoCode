import type { AskRequestInfo } from '@shared/types/agent';
import { describe, expect, it, vi } from 'vitest';
import {
  ASK_NO_USER_ERROR,
  ASK_RELAY_TIMEOUT_MS,
  AskManager,
  type AskResolution,
  createAskTool,
} from './ask';

const make = (humanTimeoutMs?: number) => {
  const infos: AskRequestInfo[] = [];
  const resolved: string[] = [];
  const resolutions: (AskResolution | undefined)[] = [];
  const manager = new AskManager(
    (info) => infos.push(info),
    (id, resolution) => {
      resolved.push(id);
      resolutions.push(resolution);
    },
    humanTimeoutMs
  );
  return { manager, infos, resolved, resolutions };
};

describe('AskManager 等人超时', () => {
  it('开启时提问带 expiresAt；expire 后按「提问超时」收尾并发出 resolved', async () => {
    const { manager, infos, resolved } = make(600_000);
    const before = Date.now();
    const run = manager.ask('选哪个？', ['a', 'b']);
    expect(infos[0].expiresAt).toBeGreaterThanOrEqual(before + 600_000);
    expect(manager.snapshot()[0].expiresAt).toBe(infos[0].expiresAt);
    manager.expire(infos[0].requestId);
    await expect(run).rejects.toThrow(/^提问超时（10 分钟未回答）/);
    expect(resolved).toEqual([infos[0].requestId]);
    manager.expire(infos[0].requestId);
    expect(resolved).toHaveLength(1);
  });

  it('带默认答案时超时按默认答案', async () => {
    const { manager, infos } = make(600_000);
    const run = manager.ask('继续吗？', undefined, { defaultAnswer: '继续' });
    manager.expire(infos[0].requestId);
    await expect(run).resolves.toMatch(/^继续/);
  });

  it('未开启时不带 expiresAt', () => {
    const { manager, infos } = make();
    void manager.ask('q').catch(() => undefined);
    expect(infos[0].expiresAt).toBeUndefined();
    manager.cancelAll();
  });

  it('默认答案是选项之一时作为推荐项上报，否则不带', () => {
    const { manager, infos } = make();
    void manager.ask('q', ['a', 'b'], { defaultAnswer: 'b' }).catch(() => undefined);
    void manager.ask('q', ['a', 'b'], { defaultAnswer: 'c' }).catch(() => undefined);
    void manager.ask('q', undefined, { defaultAnswer: 'a' }).catch(() => undefined);
    expect(infos.map((info) => info.recommended)).toEqual(['b', undefined, undefined]);
    manager.cancelAll();
  });
});

describe('转交给秘书的提问', () => {
  it('无人值守时不再直接拒绝：提问带 relay 与默认 30 分钟超时', () => {
    const { manager, infos } = make();
    manager.autoReject = true;
    manager.relay = { name: '小秘' };
    const before = Date.now();
    void manager.ask('用哪个方案？', ['A', 'B']).catch(() => undefined);
    expect(infos).toHaveLength(1);
    expect(infos[0].relay).toEqual({ name: '小秘' });
    expect(infos[0].expiresAt).toBeGreaterThanOrEqual(before + ASK_RELAY_TIMEOUT_MS);
    manager.cancelAll();
  });

  it('提问自带超时时按它算，不套默认值', () => {
    const { manager, infos } = make();
    manager.relay = { name: '小秘' };
    const before = Date.now();
    void manager.ask('q', undefined, { timeoutMs: 60_000 }).catch(() => undefined);
    expect(infos[0].expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(infos[0].expiresAt).toBeLessThan(before + ASK_RELAY_TIMEOUT_MS);
    manager.cancelAll();
  });

  it('秘书代答：原会话拿到答案，收尾信息带 by=relay 与名字', async () => {
    const { manager, infos, resolutions } = make();
    manager.relay = { name: '小秘' };
    const run = manager.ask('用哪个方案？', ['A', 'B']);
    manager.respond(infos[0].requestId, 'A', { by: 'relay', name: '小秘' });
    await expect(run).resolves.toBe('A');
    expect(resolutions).toEqual([{ by: 'relay', answer: 'A', name: '小秘' }]);
  });

  it('用户在原会话里先答：收尾信息带 by=user', async () => {
    const { manager, infos, resolutions } = make();
    manager.relay = { name: '小秘' };
    const run = manager.ask('用哪个方案？', ['A', 'B']);
    manager.respond(infos[0].requestId, 'B');
    await expect(run).resolves.toBe('B');
    expect(resolutions).toEqual([{ by: 'user', answer: 'B' }]);
  });

  it('没人答到点：有默认值按默认值，没有就按无人值守拒绝', async () => {
    vi.useFakeTimers();
    try {
      const { manager, resolutions } = make();
      manager.relay = { name: '小秘' };
      const withDefault = manager.ask('继续吗？', ['继续', '停'], { defaultAnswer: '继续' });
      const withoutDefault = manager.ask('用哪个？');
      const withDefaultCheck = expect(withDefault).resolves.toMatch(/^继续/);
      const withoutDefaultCheck = expect(withoutDefault).rejects.toThrow(ASK_NO_USER_ERROR);
      await vi.advanceTimersByTimeAsync(ASK_RELAY_TIMEOUT_MS);
      await withDefaultCheck;
      await withoutDefaultCheck;
      expect(resolutions.map((resolution) => resolution?.by)).toEqual(['timeout', 'timeout']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('取消转交开关后恢复成无人值守直接拒绝', async () => {
    const { manager, infos } = make();
    manager.autoReject = true;
    manager.relay = { name: '小秘' };
    delete manager.relay;
    await expect(manager.ask('q')).rejects.toThrow(ASK_NO_USER_ERROR);
    expect(infos).toHaveLength(0);
  });
});

describe('无人值守：没人能回答提问', () => {
  it('开关打开时 ask 不发请求也不建 pending，直接按「没人回答」失败', async () => {
    const { manager, infos } = make(600_000);
    manager.autoReject = true;
    await expect(manager.ask('选哪个？', ['a', 'b'])).rejects.toThrow(ASK_NO_USER_ERROR);
    expect(infos).toHaveLength(0);
    expect(manager.snapshot()).toHaveLength(0);
  });

  it('ask_user 工具在开关打开时直接失败，提示按最合理假设继续', async () => {
    const { manager } = make(600_000);
    manager.autoReject = true;
    const tool = createAskTool(manager);
    await expect(
      tool.execute('call-ask', { question: '用哪个分支？' }, undefined, undefined, {} as never)
    ).rejects.toThrow(/no user available/i);
  });

  it('开关关闭后恢复等人', () => {
    const { manager, infos } = make();
    manager.autoReject = true;
    manager.autoReject = false;
    void manager.ask('q').catch(() => undefined);
    expect(infos).toHaveLength(1);
    manager.cancelAll();
  });
});
