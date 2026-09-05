import { describe, expect, it } from 'vitest';
import { parseLearnedLines } from './memorySnapshot';

describe('parseLearnedLines', () => {
  it('strips bullets and drops blanks', () => {
    expect(parseLearnedLines('- one\n\n- two _(context: x)_\nplain')).toEqual([
      'one',
      'two _(context: x)_',
      'plain',
    ]);
  });
});
