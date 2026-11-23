import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { demandPrClaimKey } from '@shared/types/demandThreads';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DemandThreadStore,
  demandRequesterIsOwner,
  getDemandThreadStore,
  peekDemandThreadStore,
  setDemandOwnerResolver,
  setDemandSessionReassignedHook,
  setDemandThreadStore,
} from './demandThreads';
import { EventClaimStore, setPreferredClaimOwnerResolver } from './eventClaims';

const dirs: string[] = [];

afterEach(() => {
  setDemandThreadStore(null);
  setDemandOwnerResolver(null);
  setDemandSessionReassignedHook(null);
  setPreferredClaimOwnerResolver(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function clock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function tempStore(options: { time?: ReturnType<typeof clock>; owners?: Set<string> } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'demand-threads-'));
  dirs.push(dir);
  const time = options.time ?? clock();
  const owners = options.owners ?? new Set<string>();
  const store = new DemandThreadStore({
    filePath: path.join(dir, 'demand-threads.json'),
    now: time.now,
    resolveIsOwner: (source) => (source.senderId ? owners.has(source.senderId) : false),
  });
  return { store, file: path.join(dir, 'demand-threads.json'), time, dir };
}

const source = {
  channel: 'telegram',
  chatId: '-1001',
  messageId: '42',
  senderId: 'owner-1',
  senderName: 'Ada',
  summary: '修登录',
};

describe('DemandThreadStore', () => {
  it('新建线程由宿主判定 owner，伪造字段无效', () => {
    const { store } = tempStore({ owners: new Set(['owner-1']) });
    const forged = store.open({
      source: { ...source, senderId: 'stranger' },
      sessionId: 'sess-a',
      requesterIsOwner: true,
    } as never);
    expect(forged.requesterIsOwner).toBe(false);
    expect(forged.status).toBe('open');

    const owner = store.open({
      source: { ...source, messageId: '43' },
      sessionId: 'sess-b',
    });
    expect(owner.requesterIsOwner).toBe(true);
  });

  it('同一来源幂等更新负责会话，不改 owner 判定', () => {
    const { store, time } = tempStore({ owners: new Set(['owner-1']) });
    const first = store.open({ source, sessionId: 'sess-a' });
    time.advance(10);
    const again = store.open({
      source: { ...source, senderId: 'stranger' },
      sessionId: 'sess-b',
      subagentId: 'child-1',
    });
    expect(again.id).toBe(first.id);
    expect(again.sessionId).toBe('sess-b');
    expect(again.subagentId).toBe('child-1');
    expect(again.requesterIsOwner).toBe(true);
    expect(again.updatedAt).toBe(time.now());
    expect(store.list()).toHaveLength(1);
  });

  it('绑定 PR 后可按仓库编号找回，open 状态推进到 pr_opened', () => {
    const { store } = tempStore();
    const thread = store.open({ source, sessionId: 'sess-a' });
    const bound = store.bindPr(
      { threadId: thread.id },
      { repo: 'Enso/App', number: 7, url: 'https://github.com/Enso/App/pull/7' }
    );
    expect(bound?.status).toBe('pr_opened');
    expect(store.findByPr('enso/app', 7)?.id).toBe(thread.id);
    expect(store.findBySource('telegram', '-1001', '42')?.pr?.number).toBe(7);
  });

  it('未给 threadId 时绑定到该会话最近的活跃线程', () => {
    const { store, time } = tempStore();
    store.open({ source, sessionId: 'sess-a' });
    time.advance(5);
    const newer = store.open({
      source: { ...source, messageId: '99' },
      sessionId: 'sess-a',
    });
    const bound = store.bindPr({ sessionId: 'sess-a' }, { repo: 'Enso/App', number: 8 });
    expect(bound?.id).toBe(newer.id);
    expect(store.findByPr('Enso/App', 8)?.id).toBe(newer.id);
  });

  it('merged 与 closed 只在首次写入 completedAt', () => {
    const { store, time } = tempStore();
    const thread = store.open({ source, sessionId: 'sess-a' });
    time.advance(20);
    const merged = store.updateStatus(thread.id, 'merged');
    expect(merged?.completedAt).toBe(time.now());
    time.advance(20);
    const again = store.updateStatus(thread.id, 'merged');
    expect(again?.completedAt).toBe(merged?.completedAt);
  });

  it('里程碑按 kind 与 dedupeKey 去重，needs_human 换 key 可以再记', () => {
    const { store } = tempStore();
    const thread = store.open({ source, sessionId: 'sess-a' });
    expect(store.recordMilestone(thread.id, 'pr_opened')).toBe(true);
    expect(store.recordMilestone(thread.id, 'pr_opened')).toBe(false);
    expect(store.recordMilestone(thread.id, 'ci_failed', { dedupeKey: 'sha-1' })).toBe(true);
    expect(store.recordMilestone(thread.id, 'ci_failed', { dedupeKey: 'sha-1' })).toBe(false);
    expect(store.recordMilestone(thread.id, 'ci_failed', { dedupeKey: 'sha-2' })).toBe(true);
    expect(store.recordMilestone(thread.id, 'needs_human', { dedupeKey: 'a' })).toBe(true);
    expect(store.recordMilestone(thread.id, 'needs_human', { dedupeKey: 'b' })).toBe(true);
    expect(store.findById(thread.id)?.milestonesSent).toHaveLength(5);
  });

  it('落盘后能恢复，坏 JSON 当成空表', () => {
    const { store, file, time } = tempStore();
    const thread = store.open({ source, sessionId: 'sess-a', secretaryId: 'sec-1' });
    store.bindPr({ threadId: thread.id }, { repo: 'Enso/App', number: 3 });
    const restored = new DemandThreadStore({ filePath: file, now: time.now });
    expect(restored.findByPr('Enso/App', 3)?.secretaryId).toBe('sec-1');

    writeFileSync(file, '{not json');
    const broken = new DemandThreadStore({ filePath: file, now: time.now });
    expect(broken.list()).toEqual([]);
  });

  it('认领键优先判给未关闭线程的负责会话', () => {
    const { store } = tempStore();
    const thread = store.open({ source: { ...source, channel: 'tg' }, sessionId: 'sess-owner' });
    store.bindPr({ threadId: thread.id }, { repo: 'Enso/App', number: 9 });
    expect(store.resolveOwnerForClaimKey(demandPrClaimKey('Enso/App', 9, 'comment'))).toBe(
      'sess-owner'
    );
    expect(store.resolveOwnerForClaimKey('tg:-1001:42')).toBe('sess-owner');
    store.updateStatus(thread.id, 'closed');
    expect(store.resolveOwnerForClaimKey('tg:-1001:42')).toBeNull();
    expect(store.resolveOwnerForClaimKey('other')).toBeNull();
  });

  it('EventClaimStore 通过 preferred resolver 把 PR 认领判给需求线程', () => {
    const { store, dir } = tempStore();
    const thread = store.open({ source, sessionId: 'sess-owner' });
    store.bindPr({ threadId: thread.id }, { repo: 'Enso/App', number: 4 });
    setPreferredClaimOwnerResolver((key) => store.resolveOwnerForClaimKey(key));
    const claims = new EventClaimStore({
      filePath: path.join(dir, 'claims.json'),
      resolvePreferredOwner: (key) => store.resolveOwnerForClaimKey(key),
    });
    const won = claims.acquire({
      key: demandPrClaimKey('Enso/App', 4, 'comment'),
      sessionId: 'sess-other',
      pluginId: 'github',
      candidates: [{ sessionId: 'sess-other' }, { sessionId: 'sess-owner' }],
    });
    expect(won.ownerSessionId).toBe('sess-owner');
    expect(won.claim.sessionId).toBe('sess-owner');
    expect(won.acquired).toBe(false);
  });

  it('单例默认核验走 setDemandOwnerResolver，未登记时不是 owner', () => {
    setDemandThreadStore(null);
    const dir = mkdtempSync(path.join(tmpdir(), 'demand-singleton-'));
    dirs.push(dir);
    const isolated = new DemandThreadStore({
      filePath: path.join(dir, 'demand-threads.json'),
      now: () => 5,
      resolveIsOwner: (source) => source.senderId === 'real-owner',
    });
    setDemandThreadStore(isolated);
    expect(peekDemandThreadStore()).toBe(isolated);
    expect(getDemandThreadStore().open({ source, sessionId: 's' }).requesterIsOwner).toBe(false);
    setDemandOwnerResolver((item) => item.senderId === 'owner-1');
    const created = new DemandThreadStore({
      filePath: path.join(dir, 'other.json'),
      now: () => 6,
    });
    expect(created.open({ source, sessionId: 's' }).requesterIsOwner).toBe(true);
  });

  it('认领键把仓库名收成小写', () => {
    expect(demandPrClaimKey('Enso/App', 9, 'comment')).toBe('github:enso/app#9:comment');
    expect(demandPrClaimKey('Enso/App', 9)).toBe('github:enso/app#9:event');
  });

  it('没有 senderId 时不会把群 chatId 当成 owner', () => {
    const groupAsPrivate = {
      telegramOwnerIds: new Set<string>(),
      telegramPrivateChatIds: new Set(['-1001']),
    };
    expect(
      demandRequesterIsOwner(
        { channel: 'telegram', chatId: '-1001', messageId: '42' },
        groupAsPrivate
      )
    ).toBe(false);
    expect(
      demandRequesterIsOwner(
        { channel: 'telegram', chatId: '-1001', messageId: '42', senderId: 'owner-1' },
        { ...groupAsPrivate, telegramOwnerIds: new Set(['owner-1']) }
      )
    ).toBe(true);
  });

  it('别的插件不能改写线程，pluginId 能落盘恢复', () => {
    const { store, file, time } = tempStore();
    const thread = store.open({ source, sessionId: 'sess-a', pluginId: 'plugin.a' });
    expect(thread.pluginId).toBe('plugin.a');
    expect(() => store.open({ source, sessionId: 'sess-b', pluginId: 'plugin.b' })).toThrow(
      /线程归属其他插件/
    );
    expect(store.findById(thread.id)?.sessionId).toBe('sess-a');
    const restored = new DemandThreadStore({ filePath: file, now: time.now });
    expect(restored.findById(thread.id)?.pluginId).toBe('plugin.a');
  });
});
