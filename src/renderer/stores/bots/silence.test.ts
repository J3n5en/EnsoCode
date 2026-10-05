import type { BotSilence } from '@shared/types/botIpc';
import { describe, expect, it } from 'vitest';
import { quietSeconds, silenceOf } from './silence';

const silence = (patch: Partial<BotSilence>): BotSilence => ({
  conversationId: 'c1',
  chatId: 'chat1',
  botId: 'b1',
  since: 1_000,
  ...patch,
});

describe('silence selectors', () => {
  it('finds the silence of a conversation', () => {
    const list = [silence({}), silence({ conversationId: 'c2', since: 5 })];
    expect(silenceOf(list, 'c2')?.since).toBe(5);
    expect(silenceOf(list, 'c3')).toBeUndefined();
    expect(silenceOf(list, undefined)).toBeUndefined();
  });

  it('counts whole seconds and never goes negative', () => {
    expect(quietSeconds(1_000, 92_999)).toBe(91);
    expect(quietSeconds(5_000, 1_000)).toBe(0);
  });
});
