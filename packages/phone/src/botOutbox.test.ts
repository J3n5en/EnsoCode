import { describe, expect, it } from 'vitest';
import { BotOutbox, indexedDbOutboxStorage, type OutboxStorage, parseOutbox } from './botOutbox';

const memory = (initial: Record<string, unknown> = {}) => {
  const data: Record<string, unknown> = { ...initial };
  const storage: OutboxStorage = {
    load: async (pairId) => data[pairId],
    save: async (pairId, items) => {
      data[pairId] = structuredClone(items);
    },
  };
  return { data, storage };
};

const make = (storage: OutboxStorage) => {
  let id = 0;
  return new BotOutbox(storage, 'pair-1', {
    newId: () => `d-${++id}`,
    now: () => 1000,
  });
};

describe('BotOutbox', () => {
  it('keeps a failed discard visible and never sends it again in the current session', async () => {
    const { storage, data } = memory();
    const box = make(storage);
    box.enqueue({ chatId: 'c', text: 'do not send' });
    await box.flushed();
    const save = storage.save;
    storage.save = async () => {
      throw new Error('disk unavailable');
    };
    await box.discard('d-1');
    expect(box.list()[0]).toMatchObject({ status: 'failed', error: 'outbox-discard' });
    expect(box.drain()).toEqual([]);
    expect(data['pair-1']).toHaveLength(1);
    storage.save = save;
    await box.discard('d-1');
    expect(box.list()).toEqual([]);
    expect(data['pair-1']).toEqual([]);
  });
  it('does not overwrite an unread queue and recovers it before saving new messages', async () => {
    const { storage, data } = memory({
      'pair-1': [
        { deliveryId: 'old', chatId: 'c', text: 'old message', createdAt: 1, status: 'pending' },
      ],
    });
    const load = storage.load;
    let fail = true;
    storage.load = async (id) => {
      if (fail) throw new Error('unavailable');
      return load(id);
    };
    const box = make(storage);
    await expect(box.restore()).rejects.toThrow();
    box.enqueue({ chatId: 'c', text: 'new message' });
    await box.flushed();
    expect(data['pair-1']).toMatchObject([{ deliveryId: 'old' }]);
    expect(box.list()[0]).toMatchObject({ status: 'failed', error: 'outbox-storage' });
    fail = false;
    box.retry('d-1');
    await box.flushed();
    expect(box.list().map((item) => item.deliveryId)).toEqual(['old', 'd-1']);
    expect(data['pair-1']).toMatchObject([{ deliveryId: 'old' }, { deliveryId: 'd-1' }]);
  });
  it('does not send until the offline copy is saved and exposes storage failure for manual retry', async () => {
    let fail = true;
    const { storage } = memory();
    const save = storage.save;
    storage.save = async (...args) => {
      if (fail) throw new Error('quota');
      await save(...args);
    };
    const box = make(storage);
    box.enqueue({ chatId: 'c', text: 'keep me', images: [{ data: 'AAA', mimeType: 'image/png' }] });
    expect(box.drain()).toEqual([]);
    await box.flushed();
    expect(box.list()[0]).toMatchObject({
      text: 'keep me',
      status: 'failed',
      error: 'outbox-storage',
    });
    expect(box.list()[0].images).toHaveLength(1);
    fail = false;
    box.retry('d-1');
    await box.flushed();
    expect(box.drain().map((item) => item.deliveryId)).toEqual(['d-1']);
  });

  it('marks an unacknowledged send as unconfirmed without automatic resend', async () => {
    const box = make(memory().storage);
    box.enqueue({ chatId: 'c', text: 'hello' });
    await box.flushed();
    box.drain();
    box.expire(61_001);
    expect(box.list()[0]).toMatchObject({ status: 'failed', error: 'delivery-unconfirmed' });
    expect(box.drain()).toEqual([]);
    box.settle('d-1', true);
    expect(box.list()).toEqual([]);
  });
  it('queues while offline and drains once with the original deliveryId', async () => {
    const { storage } = memory();
    const box = make(storage);
    const item = box.enqueue({ chatId: 'c1', text: 'hi' });
    expect(item.status).toBe('pending');
    await box.flushed();
    expect(box.drain().map((x) => x.deliveryId)).toEqual(['d-1']);
    // 已在途的不再重复发出
    expect(box.drain()).toEqual([]);
    expect(box.list('c1')[0].status).toBe('sending');
  });

  it('replays in-flight items after reconnect without changing deliveryId', async () => {
    const { storage } = memory();
    const box = make(storage);
    box.enqueue({ chatId: 'c1', text: 'a' });
    box.enqueue({ chatId: 'c1', text: 'b' });
    await box.flushed();
    expect(box.drain()).toHaveLength(2);
    box.interrupted();
    expect(box.drain().map((x) => x.deliveryId)).toEqual(['d-1', 'd-2']);
    box.settle('d-1', true);
    box.settle('d-1', true);
    expect(box.list().map((x) => x.deliveryId)).toEqual(['d-2']);
  });

  it('ignores results for unknown deliveries', () => {
    const box = make(memory().storage);
    box.settle('other', false, 'x');
    expect(box.list()).toEqual([]);
  });

  it('failure waits for manual retry, which reuses the same deliveryId', async () => {
    const box = make(memory().storage);
    box.enqueue({ chatId: 'c1', text: 'a' });
    await box.flushed();
    box.drain();
    box.settle('d-1', false, 'chat-stopping');
    expect(box.list()[0]).toMatchObject({ status: 'failed', error: 'chat-stopping' });
    expect(box.drain()).toEqual([]);
    box.interrupted();
    expect(box.list()[0].status).toBe('failed');
    box.retry('d-1');
    await box.flushed();
    expect(box.drain().map((x) => x.deliveryId)).toEqual(['d-1']);
    await box.discard('d-1');
    expect(box.list()).toEqual([]);
  });

  it('persists across restarts; in-flight items come back as pending', async () => {
    const { storage, data } = memory();
    const first = make(storage);
    first.enqueue({ chatId: 'c1', text: 'a', images: [{ data: 'AAA', mimeType: 'image/png' }] });
    await first.flushed();
    first.drain();
    await first.flushed();
    expect(data['pair-1']).toHaveLength(1);

    const second = make(storage);
    await second.restore();
    expect(second.list()).toEqual([
      {
        deliveryId: 'd-1',
        chatId: 'c1',
        text: 'a',
        images: [{ data: 'AAA', mimeType: 'image/png' }],
        createdAt: 1000,
        status: 'pending',
      },
    ]);
    expect(second.drain().map((x) => x.deliveryId)).toEqual(['d-1']);
  });

  it('restore merges with items enqueued before the load finished', async () => {
    const { storage } = memory({
      'pair-1': [{ deliveryId: 'old', chatId: 'c1', text: 'x', createdAt: 1, status: 'failed' }],
    });
    const box = make(storage);
    box.enqueue({ chatId: 'c1', text: 'new' });
    await box.restore();
    expect(box.list().map((x) => x.deliveryId)).toEqual(['old', 'd-1']);
  });

  it('notifies listeners on every change', async () => {
    const box = make(memory().storage);
    const seen: number[] = [];
    box.subscribe((items) => seen.push(items.length));
    box.enqueue({ chatId: 'c1', text: 'a' });
    await box.discard('d-1');
    expect(seen[0]).toBe(1);
    expect(seen.at(-1)).toBe(0);
  });
});

describe('parseOutbox', () => {
  it('drops malformed records and dedupes by deliveryId', () => {
    expect(
      parseOutbox([
        null,
        { deliveryId: 'a', chatId: 'c', text: 't', createdAt: 1, status: 'sending' },
        { deliveryId: 'a', chatId: 'c', text: 'dup', createdAt: 2, status: 'pending' },
        { deliveryId: '', chatId: 'c', text: 't', createdAt: 1, status: 'pending' },
        { deliveryId: 'b', chatId: 'c', text: 't', createdAt: 1, status: 'weird' },
        { deliveryId: 'c', chatId: 'c', text: 't', createdAt: 1, status: 'failed', images: [1] },
        { deliveryId: 'd', chatId: 'c', text: 't', createdAt: 1, status: 'failed', error: 'x' },
      ])
    ).toEqual([
      { deliveryId: 'a', chatId: 'c', text: 't', createdAt: 1, status: 'pending' },
      { deliveryId: 'b', chatId: 'c', text: 't', createdAt: 1, status: 'pending' },
      { deliveryId: 'd', chatId: 'c', text: 't', createdAt: 1, status: 'failed', error: 'x' },
    ]);
    expect(parseOutbox('garbage')).toEqual([]);
  });
});

it('waits for the IndexedDB transaction commit, not just request success', async () => {
  const request: { result: unknown; onsuccess?: () => void } = { result: undefined };
  const transaction: {
    error: Error | null;
    objectStore(): unknown;
    oncomplete?: () => void;
    onabort?: () => void;
  } = { error: null, objectStore: () => ({ put: () => request }) };
  const opened: { result: unknown; onsuccess?: () => void } = {
    result: { transaction: () => transaction },
  };
  const storage = indexedDbOutboxStorage({ open: () => opened } as unknown as IDBFactory);
  let committed = false;
  const saving = storage.save('p', [
    { deliveryId: 'd', chatId: 'c', text: 'hi', createdAt: 1, status: 'pending' },
  ]);
  const result = saving.then(
    () => {
      committed = true;
    },
    (error: unknown) => error
  );
  opened.onsuccess?.();
  await Promise.resolve();
  await Promise.resolve();
  request.onsuccess?.();
  await Promise.resolve();
  expect(committed).toBe(false);
  transaction.error = new Error('quota at commit');
  transaction.onabort?.();
  expect(await result).toBe(transaction.error);
});
