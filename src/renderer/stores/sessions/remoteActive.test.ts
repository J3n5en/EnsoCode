// 完整模式与桌面共用 enso-conversations，但多端合并不带 activeId。
// 手机切会话后重启会读回磁盘上的旧当前会话，所以远程界面单独记住。
import { describe, expect, it } from 'vitest';
import {
  mergeWithRememberedActive,
  pickRememberedActive,
  readRememberedActive,
  remotePairScope,
  trackRemoteActive,
  writeRememberedActive,
} from './remoteActive';

const memory = () => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
};

describe('remote active conversation', () => {
  it('reads the paired device from the desk renderer path', () => {
    expect(remotePairScope('/desk/r/pair%2F1/1.2.3/index.html')).toBe('pair/1');
    expect(remotePairScope('/desk/r/abc/9/settings.html')).toBe('abc');
    expect(remotePairScope('/')).toBeNull();
    expect(remotePairScope('/desk/r/%E0%A4%A/1/index.html')).toBeNull();
  });

  it('keeps a remembered conversation only when it still exists', () => {
    const exists = (id: string) => id === 'b' || id === 'a';
    expect(pickRememberedActive('a', 'b', exists)).toBe('b');
    expect(pickRememberedActive('a', 'gone', exists)).toBe('a');
    expect(pickRememberedActive('a', null, exists)).toBe('a');
    expect(pickRememberedActive(null, 'gone', exists)).toBeNull();
  });

  it('round-trips the remembered id per device and drops an empty one', () => {
    const storage = memory();
    writeRememberedActive(storage, 'desk-1', 'conv-b');
    expect(readRememberedActive(storage, 'desk-1')).toBe('conv-b');
    expect(readRememberedActive(storage, 'desk-2')).toBeNull();
    writeRememberedActive(storage, 'desk-1', null);
    expect(readRememberedActive(storage, 'desk-1')).toBeNull();
    storage.setItem('enso-remote-active:desk-1', '   ');
    expect(readRememberedActive(storage, 'desk-1')).toBeNull();
  });

  it('overrides only activeId when merging the shared conversation blob', () => {
    const current = {
      conversations: {},
      order: [] as string[],
      activeId: null as string | null,
      send: () => 'keep',
    };
    const persisted = {
      conversations: { a: { id: 'a' }, b: { id: 'b' } },
      order: ['a', 'b'],
      activeId: 'a',
    };
    const merged = mergeWithRememberedActive(current, persisted, 'b');
    expect(merged.activeId).toBe('b');
    expect(merged.order).toEqual(['a', 'b']);
    expect(merged.conversations).toEqual(persisted.conversations);
    expect(merged.send()).toBe('keep');
    expect(mergeWithRememberedActive(current, persisted, 'missing').activeId).toBe('a');
    expect(mergeWithRememberedActive(current, undefined, 'b').activeId).toBeNull();
  });

  it('writes when the open conversation changes and not on other updates', () => {
    let state = { activeId: null as string | null, title: '' };
    const listeners = new Set<(next: typeof state, prev: typeof state) => void>();
    const store = {
      getState: () => state,
      set(partial: Partial<typeof state>) {
        const prev = state;
        state = { ...state, ...partial };
        for (const listener of listeners) listener(state, prev);
      },
      subscribe(listener: (next: typeof state, prev: typeof state) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const storage = memory();
    trackRemoteActive(store, storage, 'desk-1');
    store.set({ title: 'streaming' });
    expect(storage.values.size).toBe(0);
    store.set({ activeId: 'conv-b' });
    expect(readRememberedActive(storage, 'desk-1')).toBe('conv-b');
    store.set({ activeId: null });
    expect(readRememberedActive(storage, 'desk-1')).toBeNull();
  });
});
