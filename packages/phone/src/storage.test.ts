import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDeviceData, loadLastView, saveLastSession, saveLastView } from './storage';

vi.mock('./sessionCache', () => ({ phoneCache: { clear: async () => {} } }));
vi.mock('./botOutbox', () => ({ phoneOutboxStorage: { remove: async () => {} } }));

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('last phone view', () => {
  it('restores a Bot chat rather than the previous Code session', () => {
    saveLastView('p1', { activeId: 'code-old', botChatId: 'group-a' });
    expect(loadLastView('p1')).toEqual({ activeId: 'code-old', botChatId: 'group-a' });
    saveLastView('p1', { activeId: 'code-next', botChatId: null });
    expect(loadLastView('p1')).toEqual({ activeId: 'code-next', botChatId: null });
  });
  it('keeps selections isolated across computers and clears them on unpair', () => {
    saveLastView('p1', { activeId: null, botChatId: 'group-a' });
    saveLastView('p2', { activeId: 'code-b', botChatId: 'direct-b' });
    clearDeviceData('p1');
    expect(loadLastView('p1')).toEqual({ activeId: null, botChatId: null });
    expect(loadLastView('p2')).toEqual({ activeId: 'code-b', botChatId: 'direct-b' });
  });
  it('preserves legacy Code selection but lets an explicit notification override Bot', () => {
    saveLastSession('p1', 'legacy');
    expect(loadLastView('p1')).toEqual({ activeId: 'legacy', botChatId: null });
    saveLastView('p1', { activeId: 'legacy', botChatId: 'group-a' });
    expect(loadLastView('p1', 'notification')).toEqual({
      activeId: 'notification',
      botChatId: null,
    });
    expect(loadLastView(null)).toEqual({ activeId: null, botChatId: null });
  });
  it('ignores malformed persisted Bot ids', () => {
    localStorage.setItem('enso-phone-last-bot-chat:p1', '../bad id');
    expect(loadLastView('p1').botChatId).toBeNull();
  });
});
