import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type DemandPrEventInput,
  type DemandThreadSource,
  demandPrClaimKey,
} from '@shared/types/demandThreads';
import { afterEach, describe, expect, it } from 'vitest';
import { DemandThreadRouter } from './demandThreadRouter';
import {
  DemandThreadStore,
  releaseReassignedDemandClaims,
  setDemandSessionReassignedHook,
} from './demandThreads';
import { EventClaimStore, setEventClaimStore } from './eventClaims';

const dirs: string[] = [];

afterEach(() => {
  setDemandSessionReassignedHook(null);
  setEventClaimStore(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness() {
  const dir = mkdtempSync(path.join(tmpdir(), 'demand-router-'));
  dirs.push(dir);
  let now = 1_000;
  const store = new DemandThreadStore({
    filePath: path.join(dir, 'demand-threads.json'),
    now: () => now,
    resolveIsOwner: (source) => source.senderId === 'owner-1',
  });
  const injected: { sessionId: string; text: string; claimKey: string }[] = [];
  const replies: { source: DemandThreadSource; text: string }[] = [];
  const router = new DemandThreadRouter({
    store,
    injectToSession: async (input) => {
      injected.push({
        sessionId: input.sessionId,
        text: input.text,
        claimKey: input.claimKey,
      });
      return { ok: true };
    },
    replyToSource: async (input) => {
      replies.push({ source: input.source, text: input.text });
      return { ok: true, messageId: `reply-${replies.length}` };
    },
  });
  const source: DemandThreadSource = {
    channel: 'telegram',
    chatId: '-1001',
    messageId: '42',
    senderId: 'owner-1',
    summary: '修登录',
  };
  const thread = store.open({ source, sessionId: 'sess-owner', secretaryId: 'sec-1' });
  store.bindPr(
    { threadId: thread.id },
    { repo: 'Enso/App', number: 7, url: 'https://example.test/7' }
  );
  return {
    store,
    router,
    injected,
    replies,
    source,
    thread,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function event(
  partial: Partial<DemandPrEventInput> & Pick<DemandPrEventInput, 'kind' | 'text'>
): DemandPrEventInput {
  return {
    repo: 'Enso/App',
    number: 7,
    url: 'https://example.test/7',
    ...partial,
  };
}

describe('DemandThreadRouter', () => {
  it('没有关联线程时不投递也不回群', async () => {
    const { router, injected, replies } = harness();
    const result = await router.routePrEvent(
      'github',
      event({ repo: 'Other/Repo', number: 1, kind: 'comment', text: 'hi' })
    );
    expect(result).toEqual({ routed: false, reason: 'no-thread' });
    expect(injected).toEqual([]);
    expect(replies).toEqual([]);
  });

  it('comment、review、ci_passed 只进负责会话，绝不回群', async () => {
    const { router, injected, replies, store } = harness();
    store.updateStatus(store.findByPr('Enso/App', 7)!.id, 'ci_failed');
    for (const kind of ['comment', 'review', 'ci_passed'] as const) {
      const result = await router.routePrEvent('github', event({ kind, text: `${kind} 正文` }));
      expect(result.routed).toBe(true);
      if (result.routed) expect(result.milestonePushed).toBe(false);
    }
    expect(injected.map((item) => item.sessionId)).toEqual([
      'sess-owner',
      'sess-owner',
      'sess-owner',
    ]);
    expect(replies).toEqual([]);
    expect(store.findByPr('Enso/App', 7)?.status).toBe('pr_opened');
  });

  it('pr_opened、ci_failed、needs_human、merged 回复原消息，重复事件不刷群', async () => {
    const { router, replies, source } = harness();
    const opened = await router.routePrEvent(
      'github',
      event({ kind: 'pr_opened', text: '开了 PR', title: '修登录' })
    );
    expect(opened.routed && opened.milestonePushed).toBe(true);
    expect(replies[0]?.source.messageId).toBe(source.messageId);
    expect(replies[0]?.text).toContain('#7');
    await router.routePrEvent('github', event({ kind: 'pr_opened', text: '又开一次' }));
    expect(replies).toHaveLength(1);

    const failed = await router.routePrEvent(
      'github',
      event({ kind: 'ci_failed', text: '红了', headSha: 'sha-1', summary: 'lint' })
    );
    expect(failed.routed && failed.milestonePushed).toBe(true);
    await router.routePrEvent(
      'github',
      event({ kind: 'ci_failed', text: '还是红', headSha: 'sha-1', summary: 'lint' })
    );
    expect(replies).toHaveLength(2);
    await router.routePrEvent(
      'github',
      event({ kind: 'ci_failed', text: '新提交红了', headSha: 'sha-2' })
    );
    expect(replies).toHaveLength(3);

    await router.routePrEvent(
      'github',
      event({ kind: 'needs_human', text: '要人看冲突', summary: '冲突' })
    );
    await router.routePrEvent(
      'github',
      event({ kind: 'needs_human', text: '要人看冲突', summary: '冲突' })
    );
    await router.routePrEvent(
      'github',
      event({ kind: 'needs_human', text: '要人看密钥', summary: '密钥' })
    );
    expect(replies).toHaveLength(5);

    const merged = await router.routePrEvent('github', event({ kind: 'merged', text: '合了' }));
    expect(merged.routed && merged.milestoneKind).toBe('merged');
    await router.routePrEvent('github', event({ kind: 'merged', text: '又合一次' }));
    expect(replies).toHaveLength(6);
    expect(replies.every((item) => item.source.messageId === '42')).toBe(true);
  });

  it('closed 只通知负责会话', async () => {
    const { router, replies, store } = harness();
    const result = await router.routePrEvent('github', event({ kind: 'closed', text: '关了' }));
    expect(result).toMatchObject({ routed: true, milestonePushed: false });
    expect(replies).toEqual([]);
    expect(store.findByPr('Enso/App', 7)?.status).toBe('closed');
  });

  it('会话完成时回复原群原消息，重复完成不再回复', async () => {
    const { router, replies, store, thread } = harness();
    const sent = await router.onSessionGoalCompleted('sess-owner', { summary: '登录修好了' });
    expect(sent).toBe(true);
    expect(replies[0]?.source.messageId).toBe('42');
    expect(replies[0]?.text).toContain('登录修好了');
    expect(store.findById(thread.id)?.status).toBe('closed');
    expect(await router.onSessionGoalCompleted('sess-owner', { summary: '再说一次' })).toBe(false);
    expect(replies).toHaveLength(1);
  });

  it('已经合并过的线程，会话完成不再刷群', async () => {
    const { router, replies } = harness();
    await router.routePrEvent('github', event({ kind: 'merged', text: '合了' }));
    expect(await router.onSessionGoalCompleted('sess-owner')).toBe(false);
    expect(replies).toHaveLength(1);
  });

  it('needs_human 从会话侧回原消息，同一 dedupeKey 不重复', async () => {
    const { router, replies, store, thread } = harness();
    expect(await router.onSessionNeedsHuman('sess-owner', '需要确认方案', 'plan')).toBe(true);
    expect(store.findById(thread.id)?.status).toBe('needs_human');
    expect(replies[0]?.source.messageId).toBe('42');
    expect(await router.onSessionNeedsHuman('sess-owner', '需要确认方案', 'plan')).toBe(false);
    expect(await router.onSessionNeedsHuman('sess-owner', '需要密钥', 'secret')).toBe(true);
    expect(replies).toHaveLength(2);
  });

  it('改派会话后旧认领被释放，新会话收得到后续 PR 事件', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'demand-router-'));
    dirs.push(dir);
    const store = new DemandThreadStore({
      filePath: path.join(dir, 'demand-threads.json'),
      now: () => 1_000,
      resolveIsOwner: () => false,
    });
    const claims = new EventClaimStore({ now: () => 1_000 });
    setEventClaimStore(claims);
    setDemandSessionReassignedHook(releaseReassignedDemandClaims);
    const source: DemandThreadSource = {
      channel: 'telegram',
      chatId: '-1001',
      messageId: '42',
      senderId: 'owner-1',
    };
    store.open({ source, sessionId: 'sess-old' });
    store.bindPr({ sessionId: 'sess-old' }, { repo: 'Enso/App', number: 7 });
    const prKey = demandPrClaimKey('Enso/App', 7, 'ci_failed');
    const tgKey = `tg:${source.chatId}:${source.messageId}`;
    claims.acquire({ key: prKey, sessionId: 'sess-old', pluginId: 'github' });
    claims.acquire({ key: tgKey, sessionId: 'sess-old', pluginId: 'github' });
    claims.acquire({ key: 'other:keep', sessionId: 'sess-old', pluginId: 'github' });
    const injected: string[] = [];
    const router = new DemandThreadRouter({
      store,
      injectToSession: async (input) => {
        const acquired = claims.acquire({
          key: input.claimKey,
          sessionId: input.sessionId,
          pluginId: 'github',
        });
        if (!acquired.acquired) return { ok: true, skipped: true };
        injected.push(input.sessionId);
        return { ok: true };
      },
      replyToSource: async () => ({ ok: true, messageId: '1' }),
    });

    store.open({ source, sessionId: 'sess-new' });
    expect(claims.ownerOf(prKey)).toBeNull();
    expect(claims.ownerOf(tgKey)).toBeNull();
    expect(claims.ownerOf('other:keep')?.sessionId).toBe('sess-old');

    const result = await router.routePrEvent(
      'github',
      event({ kind: 'ci_failed', text: '红了', headSha: 'sha-9' })
    );
    expect(result).toMatchObject({ routed: true, sessionId: 'sess-new', delivered: true });
    expect(injected).toEqual(['sess-new']);
  });

  it('并发重放同一里程碑只回群一次', async () => {
    const { router, replies } = harness();
    const burst = (
      kind: 'pr_opened' | 'ci_failed' | 'merged',
      extra: Partial<DemandPrEventInput> = {}
    ) =>
      Promise.all([
        router.routePrEvent('github', event({ kind, text: kind, ...extra })),
        router.routePrEvent('github', event({ kind, text: kind, ...extra })),
      ]);
    await burst('pr_opened');
    expect(replies).toHaveLength(1);
    await burst('ci_failed', { headSha: 'sha-1' });
    expect(replies).toHaveLength(2);
    await burst('merged');
    expect(replies).toHaveLength(3);
  });

  it('并发完成同一线程只回群一次', async () => {
    const { router, replies } = harness();
    const [first, second] = await Promise.all([
      router.onSessionGoalCompleted('sess-owner', { summary: '一次' }),
      router.onSessionGoalCompleted('sess-owner', { summary: '两次' }),
    ]);
    expect(replies).toHaveLength(1);
    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it('线程关闭后迟到的 merged 和 ci_failed 不再回群', async () => {
    const { router, replies } = harness();
    expect(await router.onSessionGoalCompleted('sess-owner', { summary: '完成' })).toBe(true);
    await router.routePrEvent('github', event({ kind: 'merged', text: '合了' }));
    await router.routePrEvent(
      'github',
      event({ kind: 'ci_failed', text: '红了', headSha: 'sha-late' })
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toContain('完成');
  });
});
