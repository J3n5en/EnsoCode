import { describe, expect, it } from 'vitest';
import type { ProjectedMessage } from '../../../shared/types/agent';
import { estimateTextTokens, messageTokens } from './turnTokens';

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const msg = (text: string, usage?: ProjectedMessage['usage']): ProjectedMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    ...(usage ? { usage } : {}),
  }) as ProjectedMessage;

describe('estimateTextTokens', () => {
  it('uses ~4 chars per token for English and ~1.5 chars per token for Chinese', () => {
    expect(estimateTextTokens('a'.repeat(400))).toBe(100);
    expect(estimateTextTokens('字'.repeat(300))).toBe(200);
    expect(estimateTextTokens(`${'字'.repeat(150)}${'a'.repeat(400)}`)).toBe(200);
    expect(estimateTextTokens('')).toBe(0);
  });
});

describe('messageTokens', () => {
  it('estimates input from the context and output from streamed text when usage is not reported', () => {
    const result = messageTokens(msg('字'.repeat(300), zero), false, 2_000);
    expect(result).toEqual({ tokens: 2_200, real: 0 });
  });

  it('counts thinking and tool call arguments as streamed output', () => {
    const message = {
      role: 'assistant',
      content: [
        { type: 'thinking', text: 'a'.repeat(400) },
        { type: 'toolCall', id: 'c', name: 'write', arguments: { b: 'x'.repeat(392) } },
      ],
    } as ProjectedMessage;
    expect(messageTokens(message, false).tokens).toBe(200);
  });

  it('prefers reported input over the context estimate while streaming', () => {
    const result = messageTokens(
      msg('a'.repeat(400), { ...zero, input: 500, cacheRead: 100 }),
      false,
      9_000
    );
    expect(result).toEqual({ tokens: 700, real: 600 });
  });

  it('takes the reported usage once the message ends, even when lower than the estimate', () => {
    const result = messageTokens(
      msg('字'.repeat(3_000), { ...zero, input: 100, output: 50 }),
      true,
      9_000
    );
    expect(result).toEqual({ tokens: 150, real: 150 });
  });

  it('keeps the estimate when a finished message reports no usage at all', () => {
    expect(messageTokens(msg('a'.repeat(400), zero), true, 1_000)).toEqual({
      tokens: 1_100,
      real: 0,
    });
  });
});
