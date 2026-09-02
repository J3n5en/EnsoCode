import { describe, expect, it } from 'vitest';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { fileChangeKeys } from './fileChangeKeys';

const edit = (over: Partial<Extract<TimelineItem, { kind: 'tool' }>>): TimelineItem => ({
  kind: 'tool',
  key: over.key ?? '1-edit',
  name: 'edit',
  summary: 'f.ts',
  output: over.output ?? null,
  state: over.state ?? 'ok',
  edits: over.edits ?? [{ oldText: 'a', newText: 'b' }],
  writeContent: null,
  todos: null,
  durationMs: over.durationMs ?? null,
  agentMeta: null,
});

describe('fileChangeKeys', () => {
  it('counts completed edit/write with a tool result', () => {
    const keys = fileChangeKeys([
      edit({ key: '1-e', output: 'ok', durationMs: 12 }),
      edit({ key: '2-e', state: 'running', output: null }),
    ]);
    expect([...keys]).toEqual(['1-e']);
  });

  it('ignores speculative ok (no result) so a new turn does not reopen Changes', () => {
    const keys = fileChangeKeys([
      edit({ key: '1-e', state: 'ok', output: null, durationMs: null }),
    ]);
    expect(keys.size).toBe(0);
  });
});
