import { describe, expect, it } from 'vitest';
import { directTurnNotice, groupBatchNotice } from './botTurnNotice';

describe('bot turn notices', () => {
  it('names the member and previews the reply in a direct chat', () => {
    expect(
      directTurnNotice({ name: 'Alice', ok: true, text: '  done\n\nall  good ' }, 'zh')
    ).toEqual({ title: 'Alice · 回复完成', body: 'done all good' });
    expect(directTurnNotice({ name: 'Alice', ok: true, text: '' }, 'en')).toEqual({
      title: 'Alice · Replied',
      body: 'Finished and waiting for you.',
    });
    expect(
      directTurnNotice({ name: 'Bob', ok: false, text: '', error: 'x'.repeat(300) }, 'zh').body
    ).toHaveLength(100);
    expect(directTurnNotice({ name: 'Bob', ok: false, text: '' }, 'zh').title).toBe(
      'Bob · 回复失败'
    );
  });

  it('explains a per-turn token cap stop and whether it was estimated', () => {
    const stop = (estimated?: true) =>
      directTurnNotice(
        {
          name: 'Bob',
          ok: false,
          text: '',
          error: 'turn-token-limit',
          ...(estimated ? { estimated } : {}),
        },
        'zh'
      ).body;
    expect(stop()).toBe('本回合用量超过单回合上限，已停止');
    expect(stop(true)).toBe('本回合用量（按估算）超过单回合上限，已停止');
  });

  it('merges a relay batch into one notice listing every participant', () => {
    expect(
      groupBatchNotice(
        {
          chatTitle: 'Team',
          names: ['Alice', 'Bob'],
          failedNames: ['Carol'],
          lastName: 'Bob',
          lastText: 'ship it',
        },
        'zh'
      )
    ).toEqual({ title: 'Team · Alice、Bob 已回复', body: 'Bob：ship it\nCarol 回复失败' });
    expect(
      groupBatchNotice({ chatTitle: 'Team', names: [], failedNames: ['Carol'] }, 'en')
    ).toEqual({ title: 'Team · Reply failed', body: 'Carol failed to reply' });
  });
});
