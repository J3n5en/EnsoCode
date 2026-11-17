import type { SecretaryContactPollState } from '@shared/types/secretary';
import { describe, expect, it } from 'vitest';
import { type TelegramApi, TelegramApiError, type TelegramUpdate } from './client';
import { ContactPoller, POLL_LONG_TIMEOUT_SEC } from './poller';

interface PendingPoll {
  timeout: number | undefined;
  resolve(updates: TelegramUpdate[]): void;
  reject(error: unknown): void;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const offline = () => new TelegramApiError('network', 'fetch failed');

function setup() {
  const polls: PendingPoll[] = [];
  const api = {
    getUpdates: (params: { timeout?: number; signal?: AbortSignal }) =>
      new Promise<TelegramUpdate[]>((resolve, reject) => {
        polls.push({ timeout: params.timeout, resolve, reject });
        params.signal?.addEventListener('abort', () => resolve([]), { once: true });
      }),
  } as unknown as TelegramApi;
  const poller = new ContactPoller({
    api: () => api,
    offset: () => 0,
    setOffset: () => {},
    onUpdate: async () => {},
    onStatus: () => {},
    onError: () => {},
    sleep: async () => {},
  });
  const state = (): SecretaryContactPollState => poller.status().state;
  /** 当前挂着的那次 getUpdates */
  const current = () => polls[polls.length - 1];
  return { poller, polls, state, current };
}

describe('ContactPoller 连通性', () => {
  it('轮询失败显示 backoff；随后成功立刻回 running；再失败又显示', async () => {
    const h = setup();
    h.poller.start();
    await flush();
    expect(h.current().timeout).toBe(POLL_LONG_TIMEOUT_SEC);

    h.current().reject(offline());
    await flush();
    expect(h.state()).toBe('backoff');
    // 刚失败过先短轮询：连上了立刻知道，不用等长轮询挂满
    expect(h.current().timeout).toBe(0);

    h.current().resolve([]);
    await flush();
    expect(h.state()).toBe('running');
    expect(h.current().timeout).toBe(POLL_LONG_TIMEOUT_SEC);

    h.current().reject(offline());
    await flush();
    expect(h.state()).toBe('backoff');
    await h.poller.stop();
  });

  it('发消息等请求连不上也挂 backoff，下一次轮询成功撤掉；再连不上再挂', async () => {
    const h = setup();
    h.poller.start();
    h.current().resolve([]);
    await flush();
    expect(h.state()).toBe('running');

    await expect(h.poller.track(() => Promise.reject(offline()))).rejects.toThrow();
    expect(h.state()).toBe('backoff');

    h.current().resolve([]);
    await flush();
    expect(h.state()).toBe('running');

    await expect(h.poller.track(() => Promise.reject(offline()))).rejects.toThrow();
    expect(h.state()).toBe('backoff');
    await h.poller.stop();
  });

  it('别的请求成功也算恢复：撤掉连不上的 backoff', async () => {
    const h = setup();
    h.poller.start();
    h.current().reject(offline());
    await flush();
    expect(h.state()).toBe('backoff');

    await h.poller.track(async () => 1);
    expect(h.state()).toBe('running');
    await h.poller.stop();
  });

  it('非连不上的轮询错误不被别的请求成功撤掉', async () => {
    const h = setup();
    h.poller.start();
    h.current().reject(new TelegramApiError('api', 'Conflict'));
    await flush();
    expect(h.state()).toBe('backoff');

    await h.poller.track(async () => 1);
    expect(h.state()).toBe('backoff');
    await h.poller.stop();
  });

  it('成功之前发出、成功之后才失败的旧请求不把提示盖回去', async () => {
    const h = setup();
    h.poller.start();
    h.current().reject(offline());
    await flush();
    expect(h.state()).toBe('backoff');

    let failLate: (error: unknown) => void = () => {};
    const late = h.poller.track(
      () =>
        new Promise((_, reject) => {
          failLate = reject;
        })
    );
    h.current().resolve([]);
    await flush();
    expect(h.state()).toBe('running');

    failLate(offline());
    await expect(late).rejects.toThrow();
    expect(h.state()).toBe('running');

    // 长轮询在别的请求成功之前发出、之后才断：同样不盖
    await h.poller.track(async () => 1);
    h.current().reject(offline());
    await flush();
    expect(h.state()).toBe('running');
    await h.poller.stop();
  });

  it('轮询没在跑时，请求失败不改状态（没人能撤）', async () => {
    const h = setup();
    await expect(h.poller.track(() => Promise.reject(offline()))).rejects.toThrow();
    expect(h.state()).toBe('stopped');
  });
});
