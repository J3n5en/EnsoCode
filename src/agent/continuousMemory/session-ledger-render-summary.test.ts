import { describe, expect, it } from 'vitest';
import { observation, reflection } from './fixtures/session.js';
import { renderSummary } from './session-ledger/index.js';

describe('session-ledger V3 summary rendering', () => {
  it('renders empty memory as an empty summary', () => {
    expect(renderSummary([], [])).toBe('');
  });

  it('keeps compacted-memory usage instructions', () => {
    const ref = reflection('eeeeeeeeeeee', ['aaaaaaaaaaaa'], {
      content: 'User prefers source-backed memory.',
    });

    const summary = renderSummary([ref], []);

    expect(summary).toContain('These are condensed memories from earlier in this session.');
    expect(summary).toContain('use the recall tool');
  });

  it('renders V3 reflections with ids', () => {
    const ref = reflection('eeeeeeeeeeee', ['aaaaaaaaaaaa'], {
      content: 'User prefers source-backed memory.',
    });

    const summary = renderSummary([ref], []);

    expect(summary).toContain('## Reflections\n[eeeeeeeeeeee] User prefers source-backed memory.');
  });

  it('renders V3 observations with ids, timestamps, relevance, and content', () => {
    const obs = observation('aaaaaaaaaaaa', {
      content: 'User confirmed recall should use exact source entry ids.',
      timestamp: '2026-05-02 10:30',
      relevance: 'high',
    });

    const summary = renderSummary([], [obs]);

    expect(summary).toContain(
      '## Observations\n[aaaaaaaaaaaa] 2026-05-02 10:30 [high] User confirmed recall should use exact source entry ids.'
    );
  });

  it('keeps raw provenance metadata out of the compact summary', () => {
    const obs = observation('aaaaaaaaaaaa', { sourceEntryIds: ['entry-user', 'entry-tool'] });
    const ref = reflection('eeeeeeeeeeee', ['aaaaaaaaaaaa']);

    const summary = renderSummary([ref], [obs]);

    expect(summary).not.toContain('sourceEntryIds');
    expect(summary).not.toContain('supportingObservationIds');
    expect(summary).not.toContain('entry-user');
    expect(summary).not.toContain('entry-tool');
    expect(summary).not.toContain('legacy');
    expect(summary).not.toContain('[object Object]');
  });

  it('carried boundary line exposes no recallable id', () => {
    const boundary = observation('000000000000', { content: 'Earlier details compacted.' });

    const summary = renderSummary([], [boundary]);

    expect(summary).toContain('## Observations\n[carried boundary] Earlier details compacted.');
    expect(summary).not.toContain('000000000000');
  });
});
