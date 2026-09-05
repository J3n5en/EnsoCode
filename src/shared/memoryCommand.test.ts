import { describe, expect, it } from 'vitest';
import { parseMemoryCommand } from './memoryCommand';

describe('parseMemoryCommand', () => {
  it('defaults to view and accepts aliases', () => {
    expect(parseMemoryCommand('/memory')).toEqual({ action: 'view' });
    expect(parseMemoryCommand('  /memory view  ')).toEqual({ action: 'view' });
    expect(parseMemoryCommand('/memory reset')).toEqual({ action: 'clear' });
    expect(parseMemoryCommand('/memory rebuild')).toEqual({ action: 'enqueue' });
    expect(parseMemoryCommand('/Memory STATS')).toEqual({ action: 'stats' });
    expect(parseMemoryCommand('/memory diagnose')).toEqual({ action: 'diagnose' });
  });

  it('rejects unknown or mid-sentence text', () => {
    expect(parseMemoryCommand('/memory foo')).toBeNull();
    expect(parseMemoryCommand('please /memory view')).toBeNull();
    expect(parseMemoryCommand('/compaction')).toBeNull();
  });
});
