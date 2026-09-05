import { describe, expect, it } from 'vitest';
import { applyExploreFold, createExploreFoldState, type LlmMessage } from './exploreFold';

const msg = (role: string, text: string, extra?: Partial<LlmMessage>): LlmMessage => ({
  role,
  content: text,
  ...extra,
});

describe('applyExploreFold', () => {
  it('replaces mark→fold tool rounds with the report', () => {
    const messages: LlmMessage[] = [
      msg('user', 'look around'),
      msg('assistant', 'marking', { toolCalls: [{ name: 'explore_mark' }] }),
      msg('toolResult', 'marked'),
      msg('assistant', 'reading', { toolCalls: [{ name: 'read' }] }),
      msg('toolResult', 'file contents'),
      msg('assistant', 'folding', { toolCalls: [{ name: 'explore_fold' }] }),
      msg('toolResult', 'folded'),
      msg('assistant', 'now implement'),
    ];
    const folded = applyExploreFold(messages, [
      { from: 1, to: 6, report: 'auth is in src/auth.ts' },
    ]);
    expect(folded.map((m) => (typeof m.content === 'string' ? m.content : ''))).toEqual([
      'look around',
      'Explore report:\nauth is in src/auth.ts',
      'now implement',
    ]);
  });

  it('leaves messages unchanged when there are no folds', () => {
    const messages = [msg('user', 'a'), msg('assistant', 'b')];
    expect(applyExploreFold(messages, [])).toBe(messages);
  });
});

describe('createExploreFoldState', () => {
  it('rejects fold without mark and double mark', () => {
    const state = createExploreFoldState();
    expect(() => state.fold('x')).toThrow(/no active explore_mark/i);
    state.mark('goal');
    expect(() => state.mark('again')).toThrow(/already active/i);
    const fold = state.fold('report');
    expect(fold.report).toBe('report');
  });
});
