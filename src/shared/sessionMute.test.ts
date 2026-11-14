import { describe, expect, it } from 'vitest';
import { isSessionMutedInStore, sessionMuteRootId } from './sessionMute';

const settings = (conversations: Record<string, { muted?: boolean }>) => ({
  'enso-conversations': { state: { conversations } },
});

describe('session mute store', () => {
  it('根会话 id 去掉子会话后缀', () => {
    expect(sessionMuteRootId('parent')).toBe('parent');
    expect(sessionMuteRootId('parent::cw-bob')).toBe('parent');
    expect(sessionMuteRootId('')).toBe('');
  });

  it('只认根会话 muted === true，子会话跟随父会话', () => {
    const saved = settings({
      parent: { muted: true },
      other: {},
    });
    expect(isSessionMutedInStore(saved, 'parent')).toBe(true);
    expect(isSessionMutedInStore(saved, 'parent::cw-bob')).toBe(true);
    expect(isSessionMutedInStore(saved, 'other')).toBe(false);
    expect(isSessionMutedInStore(saved, 'missing')).toBe(false);
  });

  it('脏配置和未静音不当作静音', () => {
    expect(isSessionMutedInStore(undefined, 'parent')).toBe(false);
    expect(isSessionMutedInStore({}, 'parent')).toBe(false);
    expect(isSessionMutedInStore({ 'enso-conversations': { state: {} } }, 'a')).toBe(false);
    expect(isSessionMutedInStore(settings({ parent: { muted: false } }), 'parent')).toBe(false);
    expect(isSessionMutedInStore('', 'parent')).toBe(false);
  });
});
