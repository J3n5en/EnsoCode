import { describe, expect, it, vi } from 'vitest';
import type { OauthCredentialSnapshot } from '@/stores/oauthCredentials';
import { runOauthCredentialRefresh } from './oauthCredentialRefresh';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('OAuth credential revision refresh', () => {
  it('ready 快照只消费轻量 key 列表，提交成功后才重验证默认模型', async () => {
    let revision = 0;
    let committed: OauthCredentialSnapshot | null = null;
    const revalidate = vi.fn();
    const snapshot = await runOauthCredentialRefresh({
      begin: () => ++revision,
      listKeys: async () => ['anthropic', 'anthropic#2', 'xai'],
      commit: (next) => {
        committed = next;
        return true;
      },
      revalidateDefaultModel: revalidate,
    });

    expect(snapshot.availability.status).toBe('ready');
    if (snapshot.availability.status !== 'ready') throw new Error('expected ready snapshot');
    expect([...snapshot.availability.authenticatedAccountKeys]).toEqual([
      'anthropic',
      'anthropic#2',
      'xai',
    ]);
    expect(committed).toBe(snapshot);
    expect(revalidate).toHaveBeenCalledOnce();
    expect(revalidate).toHaveBeenCalledWith(snapshot);
  });

  it('较旧请求晚返回时 commit=false，不覆盖新快照也不触发默认写回', async () => {
    const first = deferred<string[]>();
    const second = deferred<string[]>();
    let revision = 0;
    let currentRevision = 0;
    const committed: OauthCredentialSnapshot[] = [];
    const revalidate = vi.fn();
    const dependencies = (listKeys: () => Promise<string[]>) => ({
      begin: () => {
        currentRevision = ++revision;
        return currentRevision;
      },
      listKeys,
      commit: (snapshot: OauthCredentialSnapshot) => {
        if (snapshot.revision !== currentRevision) return false;
        committed.push(snapshot);
        return true;
      },
      revalidateDefaultModel: revalidate,
    });

    const oldRefresh = runOauthCredentialRefresh(dependencies(() => first.promise));
    const newRefresh = runOauthCredentialRefresh(dependencies(() => second.promise));
    second.resolve(['anthropic#2']);
    await newRefresh;
    first.resolve(['anthropic']);
    await oldRefresh;

    expect(committed).toHaveLength(1);
    expect(committed[0]?.revision).toBe(2);
    expect(revalidate).toHaveBeenCalledOnce();
  });

  it('key 读取失败只提交 error fail-closed 状态，不重验证也不写回默认', async () => {
    const commit = vi.fn(() => true);
    const revalidate = vi.fn();
    const snapshot = await runOauthCredentialRefresh({
      begin: () => 7,
      listKeys: async () => {
        throw new Error('auth.json unavailable');
      },
      commit,
      revalidateDefaultModel: revalidate,
    });

    expect(snapshot).toEqual({
      revision: 7,
      availability: { status: 'error', error: 'auth.json unavailable' },
    });
    expect(commit).toHaveBeenCalledWith(snapshot);
    expect(revalidate).not.toHaveBeenCalled();
  });
});
