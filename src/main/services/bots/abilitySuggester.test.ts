import { describe, expect, it, vi } from 'vitest';
import type { AbilitySuggestInput } from '../../../shared/bots/abilitySuggest';
import { suggestAbilities, suggestGoal, suggestPersona } from './abilitySuggester';

const input: AbilitySuggestInput = {
  profile: { name: 'Rex', title: 'Reviewer', scope: 'Reviews PRs', persona: '' },
  language: 'en',
  skills: [{ id: 'skill-review', name: 'code-review' }],
  mcpServers: [],
  members: [],
};

describe('suggestAbilities', () => {
  it('returns the parsed suggestion', async () => {
    const complete = vi.fn(
      async (_request: { timeoutMs: number }, _signal: AbortSignal) =>
        '{"tools":{"value":"readonly","reason":"reads"}}'
    );
    expect(await suggestAbilities(input, complete)).toEqual({
      ok: true,
      suggestion: { tools: { value: 'readonly', reason: 'reads' } },
    });
    expect(complete.mock.calls[0]?.[0]).toMatchObject({ timeoutMs: 20_000 });
  });

  it('reports no-model when no cheap model is available', async () => {
    expect(await suggestAbilities(input, async () => null)).toEqual({
      ok: false,
      error: 'no-model',
    });
  });

  it('reports invalid-reply when the model answer cannot be parsed', async () => {
    expect(await suggestAbilities(input, async () => 'sure!')).toEqual({
      ok: false,
      error: 'invalid-reply',
    });
  });

  it('times out and aborts the request', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const pending = suggestAbilities(
        input,
        (_request, s) => {
          signal = s;
          return new Promise<string>(() => {});
        },
        1_000
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toEqual({ ok: false, error: 'timeout' });
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports failed with the message when the completion throws', async () => {
    expect(
      await suggestAbilities(input, async () => {
        throw new Error('401 unauthorized');
      })
    ).toEqual({ ok: false, error: 'failed', detail: '401 unauthorized' });
  });
});

describe('suggestPersona', () => {
  const persona = { name: '阿运', title: '运维', scope: '', persona: '', language: 'zh' as const };
  it('returns persona and scope from the reply', async () => {
    expect(
      await suggestPersona(persona, async () => '{"persona":"你是阿运","scope":"部署"}')
    ).toEqual({
      ok: true,
      suggestion: { persona: '你是阿运', scope: '部署' },
    });
  });
  it('maps no model, bad reply and timeout', async () => {
    expect(await suggestPersona(persona, async () => null)).toEqual({
      ok: false,
      error: 'no-model',
    });
    expect(await suggestPersona(persona, async () => 'nope')).toEqual({
      ok: false,
      error: 'invalid-reply',
    });
    const hang = (_r: unknown, signal: AbortSignal) =>
      new Promise<string>((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('x')))
      );
    expect(await suggestPersona(persona, hang, 5)).toEqual({ ok: false, error: 'timeout' });
  });
});

describe('suggestGoal', () => {
  const goal = {
    goal: '做个小程序',
    language: 'zh' as const,
    templates: [{ id: 'software', title: '软件开发小队', summary: '前后端测试' }],
  };
  it('returns the recommended team with the drafted first message', async () => {
    const complete = vi.fn(
      async (_request: { userText: string }, _signal: AbortSignal) =>
        '{"kind":"team","templateId":"software","firstMessage":"开工"}'
    );
    expect(await suggestGoal(goal, complete)).toEqual({
      ok: true,
      suggestion: { kind: 'team', templateId: 'software', reason: '', firstMessage: '开工' },
    });
    expect(complete.mock.calls[0][0]).toMatchObject({
      userText: expect.stringContaining('software'),
    });
  });
  it('rejects a template the user does not have', async () => {
    expect(
      await suggestGoal(goal, async () => '{"kind":"team","templateId":"legal","firstMessage":"x"}')
    ).toEqual({ ok: false, error: 'invalid-reply' });
  });
});
