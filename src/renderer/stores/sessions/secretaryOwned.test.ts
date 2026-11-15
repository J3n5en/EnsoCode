import { afterEach, describe, expect, it } from 'vitest';
import { isSecretaryOwned, setTakenOverSessions } from './secretaryOwned';

afterEach(() => setTakenOverSessions([]));

describe('isSecretaryOwned', () => {
  it('秘书派出的会话认 secretaryOrigin，不看标题', () => {
    expect(
      isSecretaryOwned({ id: 'c1', secretaryOrigin: { secretaryConversationId: 'sec' } })
    ).toBe(true);
    expect(isSecretaryOwned({ id: 'c2' })).toBe(false);
  });

  it('用户交给秘书接管的会话也算秘书负责，收回后恢复', () => {
    setTakenOverSessions(['c3']);
    expect(isSecretaryOwned({ id: 'c3' })).toBe(true);
    expect(isSecretaryOwned({ id: 'c4' })).toBe(false);
    setTakenOverSessions([]);
    expect(isSecretaryOwned({ id: 'c3' })).toBe(false);
  });
});
