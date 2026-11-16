import { describe, expect, it } from 'vitest';
import { personaExtension } from './personaExtension';

type Handler = (event: { systemPrompt: string }) => { systemPrompt: string };

function run(holder: { current: string }): () => string {
  let handler: Handler | undefined;
  const pi = { on: (_event: string, fn: Handler) => (handler = fn) };
  (personaExtension(holder) as { factory: (pi: unknown) => void }).factory(pi);
  return () => handler!({ systemPrompt: 'base' }).systemPrompt;
}

describe('personaExtension', () => {
  it('已有会话换了人设：下一轮用新正文，不需要重建会话', () => {
    const holder = { current: 'Address the user as "J 哥".' };
    const nextTurn = run(holder);
    expect(nextTurn()).toContain('J 哥');
    holder.current = 'Address the user as "哥哥".';
    expect(nextTurn()).toContain('哥哥');
    expect(nextTurn()).not.toContain('J 哥');
  });
});
