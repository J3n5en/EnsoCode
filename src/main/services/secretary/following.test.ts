import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SecretaryAuditEntry } from '@shared/types/secretary';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FOLLOWING_LIMIT,
  type FollowDeps,
  FollowingStore,
  parseFollowingFile,
  recordPhoneFollow,
  renameFollowedTarget,
  unfollowTarget,
} from './following';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'secretary-following-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 探针默认只认 sec-1 这一轮来自手机（chat 777）；审计与时钟都记在内存里 */
function deps(dir: string, phone: readonly string[] = ['sec-1']): FollowDeps {
  const audits: SecretaryAuditEntry[] = [];
  let now = 1_000;
  return {
    store: new FollowingStore(dir),
    probe: (conversationId) =>
      conversationId !== null && phone.includes(conversationId)
        ? { channelId: 'telegram', peerId: '777' }
        : null,
    audit: (entry) => audits.push(entry),
    now: () => (now += 1),
  };
}

describe('手机关注列表', () => {
  it('手机发起的回合记进关注：带 chat、摘要与时间，并留审计', () => {
    const dir = tempDir();
    const d = deps(dir);
    expect(
      recordPhoneFollow(
        {
          kind: 'session',
          targetId: 'c1',
          summary: 'apple-table 加 Score 字段',
          secretaryConversationId: 'sec-1',
        },
        d
      )
    ).toBe(true);
    expect(d.store.list()).toEqual([
      {
        id: 'session:c1',
        kind: 'session',
        targetId: 'c1',
        origin: { channelId: 'telegram', peerId: '777' },
        at: 1_001,
        summary: 'apple-table 加 Score 字段',
        secretaryConversationId: 'sec-1',
      },
    ]);
  });

  it('不是手机发起的回合不进关注列表', () => {
    const dir = tempDir();
    const d = deps(dir, []);
    expect(
      recordPhoneFollow(
        { kind: 'session', targetId: 'c1', summary: '修构建', secretaryConversationId: 'sec-1' },
        d
      )
    ).toBe(false);
    expect(d.store.list()).toEqual([]);
  });

  it('重启后关注列表还在', () => {
    const dir = tempDir();
    recordPhoneFollow(
      {
        kind: 'schedule',
        targetId: 'sch1',
        summary: '每天早上看 CI',
        secretaryConversationId: 'sec-1',
      },
      deps(dir)
    );
    // 新的 store 从磁盘读：内存态没有留下任何东西
    expect(new FollowingStore(dir).list()).toMatchObject([
      {
        id: 'schedule:sch1',
        kind: 'schedule',
        summary: '每天早上看 CI',
        origin: { channelId: 'telegram', peerId: '777' },
      },
    ]);
  });

  it(`最多 ${FOLLOWING_LIMIT} 条，超过按时间淘汰最旧的`, () => {
    const dir = tempDir();
    const d = deps(dir);
    for (let index = 0; index < FOLLOWING_LIMIT + 3; index += 1) {
      recordPhoneFollow(
        {
          kind: 'session',
          targetId: `c${index}`,
          summary: `第 ${index} 件`,
          secretaryConversationId: 'sec-1',
        },
        d
      );
    }
    const list = d.store.list();
    expect(list).toHaveLength(FOLLOWING_LIMIT);
    expect(list[0]?.targetId).toBe('c3');
    expect(list.at(-1)?.targetId).toBe(`c${FOLLOWING_LIMIT + 2}`);
  });

  it('同一个目标再记一次只刷新摘要，不会多一条', () => {
    const dir = tempDir();
    const d = deps(dir);
    const input = {
      kind: 'session' as const,
      targetId: 'c1',
      secretaryConversationId: 'sec-1',
    };
    recordPhoneFollow({ ...input, summary: '旧的' }, d);
    recordPhoneFollow({ ...input, summary: '新的' }, d);
    expect(d.store.list()).toMatchObject([{ targetId: 'c1', summary: '新的' }]);
  });

  it('等待中的派发建出会话后改挂到会话上', () => {
    const dir = tempDir();
    const d = deps(dir);
    recordPhoneFollow(
      {
        kind: 'session',
        targetId: 'pending-1',
        summary: '修构建',
        secretaryConversationId: 'sec-1',
      },
      d
    );
    renameFollowedTarget('pending-1', 'c9', d);
    expect(d.store.list()).toMatchObject([{ id: 'session:c9', targetId: 'c9' }]);
  });

  it('会话被归档、删除或收回接管时移除关注', () => {
    const dir = tempDir();
    const d = deps(dir);
    recordPhoneFollow(
      { kind: 'session', targetId: 'c1', summary: '修构建', secretaryConversationId: 'sec-1' },
      d
    );
    unfollowTarget('c1', d);
    expect(d.store.list()).toEqual([]);
  });

  it('坏配置一律当空：读不懂的条目跳过，不顶掉整张列表', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'following.json'),
      JSON.stringify({
        version: 1,
        items: [
          { kind: 'session', targetId: 'c1', chatId: 7, at: 1, summary: '好的' },
          { kind: 'nope', targetId: 'c2' },
          { kind: 'schedule' },
          { kind: 'session', targetId: 'c1', chatId: 7, at: 2, summary: '重复' },
        ],
      }),
      'utf8'
    );
    expect(new FollowingStore(dir).list()).toMatchObject([
      { targetId: 'c1', summary: '好的', origin: { channelId: 'telegram', peerId: '7' } },
    ]);
    expect(parseFollowingFile('nonsense')).toEqual({ version: 1, items: [] });
  });

  it('按渠道清关注：只清这个渠道发起的', () => {
    const dir = tempDir();
    const store = new FollowingStore(dir);
    store.add({
      kind: 'session',
      targetId: 'a',
      origin: { channelId: 'telegram', peerId: '777' },
      at: 1,
      summary: 'a',
    });
    store.add({
      kind: 'session',
      targetId: 'b',
      origin: { channelId: 'enso.clawbot:wechat', peerId: 'wx-1' },
      at: 2,
      summary: 'b',
    });
    expect(store.clearChannel('enso.clawbot:wechat')).toBe(1);
    expect(store.list().map((item) => item.targetId)).toEqual(['a']);
  });
});
