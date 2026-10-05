import type { AttachedImage } from '@shared/types/agent';

/**
 * Bot 发送离线队列：断线或后台时先落 IndexedDB，恢复在线后按原 deliveryId 重发。
 * Main 按 deliveryId 去重（私聊看会话已开始的投递，群聊看时间线人类条目），故重放幂等。
 */
export type OutboxStatus = 'pending' | 'sending' | 'failed';

export interface OutboxItem {
  deliveryId: string;
  chatId: string;
  text: string;
  images?: AttachedImage[];
  createdAt: number;
  status: OutboxStatus;
  error?: string;
}

export interface OutboxStorage {
  load(pairId: string): Promise<unknown>;
  save(pairId: string, items: OutboxItem[]): Promise<void>;
  remove?(pairId: string): Promise<void>;
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const isImage = (value: unknown): value is AttachedImage =>
  !!value &&
  typeof value === 'object' &&
  isText((value as AttachedImage).data) &&
  isText((value as AttachedImage).mimeType);

/** 读盘收窄：坏记录丢弃，在途的视为待发（结果未知，按原 id 重发由 Main 去重） */
export function parseOutbox(value: unknown): OutboxItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const items: OutboxItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const v = raw as Record<string, unknown>;
    if (!isText(v.deliveryId) || !isText(v.chatId) || typeof v.text !== 'string') continue;
    if (typeof v.createdAt !== 'number' || seen.has(v.deliveryId)) continue;
    if (v.images !== undefined && !(Array.isArray(v.images) && v.images.every(isImage))) continue;
    seen.add(v.deliveryId);
    const failed = v.status === 'failed';
    items.push({
      deliveryId: v.deliveryId,
      chatId: v.chatId,
      text: v.text,
      ...(v.images ? { images: v.images as AttachedImage[] } : {}),
      createdAt: v.createdAt,
      status: failed ? 'failed' : 'pending',
      ...(failed && typeof v.error === 'string' ? { error: v.error } : {}),
    });
  }
  return items;
}

export class BotOutbox {
  private items: OutboxItem[] = [];
  private listeners = new Set<(items: readonly OutboxItem[]) => void>();
  private writing: Promise<void> = Promise.resolve();
  private newId: () => string;
  private now: () => number;
  private durable = new Set<string>();
  private sentAt = new Map<string, number>();
  private loadFailed = false;
  private loading: Promise<void> | undefined;

  constructor(
    private storage: OutboxStorage,
    private pairId: string,
    options: { newId?: () => string; now?: () => number } = {}
  ) {
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.now = options.now ?? Date.now;
  }

  async restore(): Promise<void> {
    const run = this.loadExisting();
    this.loading = run;
    try {
      await run;
    } finally {
      if (this.loading === run) this.loading = undefined;
    }
  }

  private async loadExisting(): Promise<void> {
    let stored: OutboxItem[];
    try {
      stored = parseOutbox(await this.storage.load(this.pairId));
      this.loadFailed = false;
    } catch (error) {
      this.loadFailed = true;
      throw error;
    }
    const known = new Set(this.items.map((item) => item.deliveryId));
    const restored = stored.filter((item) => !known.has(item.deliveryId));
    if (restored.length === 0) return;
    this.items = [...restored, ...this.items];
    for (const item of restored) this.durable.add(item.deliveryId);
    for (const listener of this.listeners) listener([...this.items]);
  }

  list(chatId?: string): OutboxItem[] {
    return chatId ? this.items.filter((item) => item.chatId === chatId) : [...this.items];
  }

  subscribe(listener: (items: readonly OutboxItem[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  enqueue(input: { chatId: string; text: string; images?: AttachedImage[] }): OutboxItem {
    const item: OutboxItem = {
      deliveryId: this.newId(),
      chatId: input.chatId,
      text: input.text,
      ...(input.images?.length ? { images: input.images } : {}),
      createdAt: this.now(),
      status: 'pending',
    };
    this.items = [...this.items, item];
    this.changed();
    return item;
  }

  /** 在线时取出待发项并标记在途；调用方负责真正发出 */
  drain(): OutboxItem[] {
    const ready = this.items.filter(
      (item) => item.status === 'pending' && this.durable.has(item.deliveryId)
    );
    if (ready.length === 0) return [];
    const ids = new Set(ready.map((item) => item.deliveryId));
    for (const id of ids) this.sentAt.set(id, this.now());
    this.update((item) => (ids.has(item.deliveryId) ? { ...item, status: 'sending' } : item));
    return ready;
  }

  /** 连接断开：在途的结果未知，退回待发 */
  interrupted(): void {
    this.sentAt.clear();
    if (!this.items.some((item) => item.status === 'sending')) return;
    this.update((item) => (item.status === 'sending' ? { ...item, status: 'pending' } : item));
  }

  settle(deliveryId: string, ok: boolean, error?: string): void {
    this.sentAt.delete(deliveryId);
    if (!this.items.some((item) => item.deliveryId === deliveryId)) return;
    if (ok) {
      this.durable.delete(deliveryId);
      this.items = this.items.filter((item) => item.deliveryId !== deliveryId);
      this.changed();
      return;
    }
    this.update((item) =>
      item.deliveryId === deliveryId
        ? { ...item, status: 'failed', ...(error ? { error } : {}) }
        : item
    );
  }

  retry(deliveryId: string): void {
    this.durable.delete(deliveryId);
    this.update((item) => {
      if (item.deliveryId !== deliveryId || item.status !== 'failed') return item;
      const { error: _error, ...rest } = item;
      return { ...rest, status: 'pending' };
    });
  }

  async discard(deliveryId: string): Promise<void> {
    if (!this.items.some((item) => item.deliveryId === deliveryId)) return;
    this.durable.delete(deliveryId);
    this.sentAt.delete(deliveryId);
    this.items = this.items.map((item) =>
      item.deliveryId === deliveryId
        ? { ...item, status: 'failed', error: 'outbox-discarding' }
        : item
    );
    for (const listener of this.listeners) listener([...this.items]);
    const run = this.writing.then(async () => {
      try {
        await this.loading;
        if (this.loadFailed) await this.loadExisting();
        await this.storage.save(
          this.pairId,
          this.items.filter((item) => item.deliveryId !== deliveryId)
        );
        this.items = this.items.filter((item) => item.deliveryId !== deliveryId);
      } catch {
        this.items = this.items.map((item) =>
          item.deliveryId === deliveryId
            ? { ...item, status: 'failed', error: 'outbox-discard' }
            : item
        );
        // 尽力保存失败标记，防止下次启动把原待发项自动发出；仍失败则保留可见警告。
        await this.storage.save(this.pairId, this.items).catch(() => {});
      }
      for (const listener of this.listeners) listener([...this.items]);
    });
    this.writing = run;
    return run;
  }

  /** 等待已排队的持久化写完（测试与解绑清理用） */
  flushed(): Promise<void> {
    return this.writing;
  }

  /** 回执丢失不等于没送达；只提示结果未知，手动重试仍沿用原 id 去重。 */
  expire(now = this.now()): void {
    for (const [id, at] of this.sentAt)
      if (now - at >= 60_000) this.settle(id, false, 'delivery-unconfirmed');
  }

  private update(map: (item: OutboxItem) => OutboxItem): void {
    this.items = this.items.map(map);
    this.changed();
  }

  private changed(): void {
    for (const listener of this.listeners) listener([...this.items]);
    this.writing = this.writing.then(async () => {
      let snapshot = [...this.items];
      try {
        await this.loading;
        if (this.loadFailed) await this.loadExisting();
        snapshot = [...this.items];
        await this.storage.save(this.pairId, snapshot);
        let ready = false;
        for (const saved of snapshot) {
          const current = this.items.find((item) => item.deliveryId === saved.deliveryId);
          if (!current || this.durable.has(saved.deliveryId)) continue;
          this.durable.add(saved.deliveryId);
          if (current.status === 'pending') ready = true;
        }
        if (ready) for (const listener of this.listeners) listener([...this.items]);
      } catch {
        this.items = this.items.map((item) => {
          if (item.status !== 'pending' || !snapshot.includes(item)) return item;
          this.durable.delete(item.deliveryId);
          return { ...item, status: 'failed', error: 'outbox-storage' };
        });
        for (const listener of this.listeners) listener([...this.items]);
      }
    });
  }
}

const DB_NAME = 'enso-phone-outbox';
const STORE_NAME = 'outbox';

/** 独立库：不和会话缓存共用，免得被其按容量淘汰 */
export function indexedDbOutboxStorage(
  factory: IDBFactory | undefined = globalThis.indexedDB
): OutboxStorage {
  let opening: Promise<IDBDatabase> | null = null;
  const database = (): Promise<IDBDatabase> => {
    if (!factory) return Promise.reject(new Error('IndexedDB unavailable'));
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME))
          request.result.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch((error) => {
      opening = null;
      throw error;
    });
    return opening;
  };
  const run = async <T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest
  ): Promise<T> => {
    const db = await database();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const request = action(tx.objectStore(STORE_NAME));
      tx.oncomplete = () => resolve(request.result as T);
      tx.onabort = () => reject(tx.error ?? new Error('Outbox transaction aborted'));
      tx.onerror = () => reject(tx.error);
      request.onerror = () => reject(request.error);
    });
  };
  return {
    load: (pairId) => run('readonly', (store) => store.get(pairId)),
    save: async (pairId, items) => {
      await run('readwrite', (store) =>
        items.length > 0 ? store.put(items, pairId) : store.delete(pairId)
      );
    },
    remove: async (pairId) => {
      await run('readwrite', (store) => store.delete(pairId));
    },
  };
}

export const phoneOutboxStorage = indexedDbOutboxStorage();
