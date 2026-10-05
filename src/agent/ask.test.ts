import type { AskRequestInfo } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import { AskManager } from './ask';

const make = (humanTimeoutMs?: number) => {
  const infos: AskRequestInfo[] = [];
  const resolved: string[] = [];
  const manager = new AskManager(
    (info) => infos.push(info),
    (id) => resolved.push(id),
    humanTimeoutMs
  );
  return { manager, infos, resolved };
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
});
