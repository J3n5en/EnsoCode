import { describe, expect, it } from 'vitest';
import {
  compactionEntry,
  memoryDetails,
  observation,
  observationsDroppedEntry,
  observationsRecordedEntry,
  oldV2CompactionDetails,
  reflection,
  reflectionsRecordedEntry,
  textCustomMessage,
} from './fixtures/session.js';
import {
  buildCompactionProjection,
  diffProjection,
  fullProjection,
  latestFullFoldBoundaryId,
  visibleProjection,
} from './session-ledger/index.js';

describe('session-ledger V3 projections', () => {
  it('full projection folds observations, reflections, and drops through the target', () => {
    const obs1 = observation('aaaaaaaaaaaa');
    const obs2 = observation('bbbbbbbbbbbb');
    const ref1 = reflection('eeeeeeeeeeee', ['aaaaaaaaaaaa']);
    const entries = [
      textCustomMessage('raw-1', 'aaaa'),
      observationsRecordedEntry('om-aaaaaaaaaaaa', {
        observations: [obs1, obs2],
        coversUpToId: 'raw-1',
      }),
      reflectionsRecordedEntry('om-eeeeeeeeeeee', { reflections: [ref1], coversUpToId: 'raw-1' }),
      observationsDroppedEntry('om-drop-1', {
        observationIds: ['aaaaaaaaaaaa'],
        coversUpToId: 'om-eeeeeeeeeeee',
      }),
    ];

    const projection = fullProjection(entries);

    expect(projection.observations.map((obs) => obs.id)).toEqual(['bbbbbbbbbbbb']);
    expect(projection.reflections.map((ref) => ref.id)).toEqual(['eeeeeeeeeeee']);
  });

  it('visible projection is empty when there is no V3 compaction', () => {
    const entries = [
      textCustomMessage('raw-1', 'aaaa'),
      observationsRecordedEntry('om-aaaaaaaaaaaa', {
        observations: [observation('aaaaaaaaaaaa')],
        coversUpToId: 'raw-1',
      }),
    ];

    expect(visibleProjection(entries)).toEqual({ observations: [], reflections: [] });
  });

  it('visible projection uses the latest valid om.folded compaction details', () => {
    const obs1 = observation('aaaaaaaaaaaa');
    const ref1 = reflection('eeeeeeeeeeee', ['aaaaaaaaaaaa']);
    const obs2 = observation('bbbbbbbbbbbb');
    const entries = [
      textCustomMessage('raw-1', 'aaaa'),
      compactionEntry('cmp-1', {
        firstKeptEntryId: 'raw-1',
        details: memoryDetails({ observations: [obs1], reflections: [] }),
      }),
      textCustomMessage('raw-2', 'bbbb'),
      compactionEntry('cmp-2', {
        firstKeptEntryId: 'raw-2',
        details: memoryDetails({ fullFold: true, observations: [obs2], reflections: [ref1] }),
      }),
    ];

    expect(visibleProjection(entries)).toEqual({ observations: [obs2], reflections: [ref1] });
  });

  it('ignores old V2 compaction details for visible projection', () => {
    const entries = [
      textCustomMessage('raw-1', 'aaaa'),
      compactionEntry('cmp-v2', { firstKeptEntryId: 'raw-1', details: oldV2CompactionDetails() }),
    ];

    expect(visibleProjection(entries)).toEqual({ observations: [], reflections: [] });
  });

  it('finds the latest full-fold boundary', () => {
    const entries = [
      textCustomMessage('raw-1', 'aaaa'),
      compactionEntry('cmp-1', {
        firstKeptEntryId: 'raw-1',
        details: memoryDetails({ fullFold: true }),
      }),
      textCustomMessage('raw-2', 'bbbb'),
      compactionEntry('cmp-2', {
        firstKeptEntryId: 'raw-2',
        details: memoryDetails({ fullFold: false }),
      }),
      textCustomMessage('raw-3', 'cccc'),
      compactionEntry('cmp-3', {
        firstKeptEntryId: 'raw-3',
        details: memoryDetails({ fullFold: true }),
      }),
    ];

    expect(latestFullFoldBoundaryId(entries)).toBe('raw-3');
  });

  it('first normal compaction includes observations by coverage and excludes maintenance streams', () => {
    const obs1 = observation('aaaaaaaaaaaa', { sourceEntryIds: ['raw-2'], tokenCount: 10 });
    const ref1 = reflection('eeeeeeeeeeee', ['aaaaaaaaaaaa']);
    const entries = [
      textCustomMessage('raw-1', 'aaaa'),
      textCustomMessage('raw-2', 'bbbb'),
      observationsRecordedEntry('om-aaaaaaaaaaaa', { observations: [obs1], coversUpToId: 'raw-2' }),
      reflectionsRecordedEntry('om-eeeeeeeeeeee', { reflections: [ref1], coversUpToId: 'raw-2' }),
      observationsDroppedEntry('om-drop-1', {
        observationIds: ['aaaaaaaaaaaa'],
        coversUpToId: 'raw-2',
      }),
    ];

    const result = buildCompactionProjection(entries, 'raw-2', { observationsPoolMaxTokens: 100 });

    expect(result.fullFold).toBe(false);
    expect(result.observations.map((obs) => obs.id)).toEqual(['aaaaaaaaaaaa']);
    expect(result.reflections).toEqual([]);
    expect(result.details).toMatchObject({ type: 'om.folded', version: 1, fullFold: false });
  });

  it('normal compaction projection includes current observations but keeps reflections and drops at latest full-fold boundary', () => {
    const obs1 = observation('aaaaaaaaaaaa', { tokenCount: 5 });
    const obs2 = observation('bbbbbbbbbbbb', { tokenCount: 5 });
    const ref1 = reflection('eeeeeeeeeeee', ['aaaaaaaaaaaa']);
    const ref2 = reflection('ffffffffffff', ['bbbbbbbbbbbb']);
    const entries = [
      textCustomMessage('raw-1', 'aaaa'),
      observationsRecordedEntry('om-aaaaaaaaaaaa', { observations: [obs1], coversUpToId: 'raw-1' }),
      reflectionsRecordedEntry('om-eeeeeeeeeeee', { reflections: [ref1], coversUpToId: 'raw-1' }),
      compactionEntry('cmp-full', {
        firstKeptEntryId: 'raw-1',
        details: memoryDetails({ fullFold: true, observations: [obs1], reflections: [ref1] }),
      }),
      textCustomMessage('raw-2', 'bbbb'),
      observationsRecordedEntry('om-bbbbbbbbbbbb', { observations: [obs2], coversUpToId: 'raw-2' }),
      reflectionsRecordedEntry('om-ffffffffffff', { reflections: [ref2], coversUpToId: 'raw-2' }),
      observationsDroppedEntry('om-drop-2', {
        observationIds: ['aaaaaaaaaaaa'],
        coversUpToId: 'raw-2',
      }),
    ];

    const result = buildCompactionProjection(entries, 'raw-2', { observationsPoolMaxTokens: 100 });

    expect(result.fullFold).toBe(false);
    expect(result.observations.map((obs) => obs.id)).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
    expect(result.reflections.map((ref) => ref.id)).toEqual(['eeeeeeeeeeee']);
    expect(result.details).toMatchObject({ type: 'om.folded', version: 1, fullFold: false });
  });

  it('full compaction projection applies reflections and drops through current boundary by coverage', () => {
    const obs1 = observation('aaaaaaaaaaaa', { tokenCount: 80 });
    const obs2 = observation('bbbbbbbbbbbb', { tokenCount: 30 });
    const ref1 = reflection('eeeeeeeeeeee', ['aaaaaaaaaaaa']);
    const ref2 = reflection('ffffffffffff', ['bbbbbbbbbbbb']);
    const entries = [
      textCustomMessage('raw-1', 'aaaa'),
      observationsRecordedEntry('om-aaaaaaaaaaaa', { observations: [obs1], coversUpToId: 'raw-1' }),
      reflectionsRecordedEntry('om-eeeeeeeeeeee', { reflections: [ref1], coversUpToId: 'raw-1' }),
      compactionEntry('cmp-full', {
        firstKeptEntryId: 'raw-1',
        details: memoryDetails({ fullFold: true, observations: [obs1], reflections: [ref1] }),
      }),
      textCustomMessage('raw-2', 'bbbb'),
      observationsRecordedEntry('om-bbbbbbbbbbbb', { observations: [obs2], coversUpToId: 'raw-2' }),
      reflectionsRecordedEntry('om-ffffffffffff', { reflections: [ref2], coversUpToId: 'raw-2' }),
      observationsDroppedEntry('om-drop-2', {
        observationIds: ['aaaaaaaaaaaa'],
        coversUpToId: 'raw-2',
      }),
    ];

    const result = buildCompactionProjection(entries, 'raw-2', { observationsPoolMaxTokens: 100 });

    expect(result.fullFold).toBe(true);
    expect(result.observations.map((obs) => obs.id)).toEqual(['bbbbbbbbbbbb']);
    expect(result.reflections.map((ref) => ref.id)).toEqual(['eeeeeeeeeeee', 'ffffffffffff']);
    expect(result.details).toMatchObject({ type: 'om.folded', version: 1, fullFold: true });
  });

  it('ignores dangling coversUpToId markers during projection', () => {
    const obs1 = observation('aaaaaaaaaaaa', { tokenCount: 10 });
    const ref1 = reflection('eeeeeeeeeeee', ['aaaaaaaaaaaa']);
    const entries = [
      textCustomMessage('raw-1', 'aaaa'),
      observationsRecordedEntry('om-aaaaaaaaaaaa', {
        observations: [obs1],
        coversUpToId: 'missing',
      }),
      reflectionsRecordedEntry('om-eeeeeeeeeeee', { reflections: [ref1], coversUpToId: 'missing' }),
      observationsDroppedEntry('om-drop-1', {
        observationIds: ['aaaaaaaaaaaa'],
        coversUpToId: 'missing',
      }),
    ];

    expect(() => fullProjection(entries, 'raw-1')).not.toThrow();
    expect(fullProjection(entries, 'raw-1')).toEqual({ observations: [], reflections: [] });
  });

  it('keeps the first covered observation and reflection for duplicate ids', () => {
    const firstObs = observation('aaaaaaaaaaaa', { content: 'first observation' });
    const secondObs = observation('aaaaaaaaaaaa', { content: 'second observation' });
    const firstRef = reflection('eeeeeeeeeeee', ['aaaaaaaaaaaa'], { content: 'first reflection' });
    const secondRef = reflection('eeeeeeeeeeee', ['aaaaaaaaaaaa'], {
      content: 'second reflection',
    });
    const entries = [
      textCustomMessage('raw-1', 'aaaa'),
      observationsRecordedEntry('om-obs-1', { observations: [firstObs], coversUpToId: 'raw-1' }),
      observationsRecordedEntry('om-obs-2', { observations: [secondObs], coversUpToId: 'raw-1' }),
      reflectionsRecordedEntry('om-ref-1', { reflections: [firstRef], coversUpToId: 'raw-1' }),
      reflectionsRecordedEntry('om-ref-2', { reflections: [secondRef], coversUpToId: 'raw-1' }),
    ];

    const projection = fullProjection(entries, 'raw-1');

    expect(projection.observations).toEqual([firstObs]);
    expect(projection.reflections).toEqual([firstRef]);
  });

  it('uses >= observationsPoolMaxTokens for full-fold pressure', () => {
    const obs1 = observation('aaaaaaaaaaaa', { tokenCount: 50 });
    const entries = [
      textCustomMessage('raw-1', 'aaaa'),
      observationsRecordedEntry('om-aaaaaaaaaaaa', { observations: [obs1], coversUpToId: 'raw-1' }),
    ];

    expect(
      buildCompactionProjection(entries, 'raw-1', { observationsPoolMaxTokens: 50 }).fullFold
    ).toBe(true);
  });

  it('reports visible/full drift', () => {
    const visible = { observations: [observation('aaaaaaaaaaaa')], reflections: [] };
    const full = {
      observations: [observation('aaaaaaaaaaaa'), observation('bbbbbbbbbbbb')],
      reflections: [reflection('eeeeeeeeeeee', ['bbbbbbbbbbbb'])],
    };

    const diff = diffProjection(visible, full);

    expect(diff.observationsOnlyInFull.map((obs) => obs.id)).toEqual(['bbbbbbbbbbbb']);
    expect(diff.reflectionsOnlyInFull.map((ref) => ref.id)).toEqual(['eeeeeeeeeeee']);
  });

  it('超预算时按 relevance 保留 top-N，边界行不带 ledger id，输出确定且 reflections 承接', () => {
    const raws = Array.from({ length: 6 }, (_, index) => textCustomMessage(`raw-${index}`, 'x'));
    const relevance = ['low', 'critical', 'medium', 'high', 'low', 'medium'] as const;
    const observations = raws.map((raw, index) =>
      observation(`${index}`.repeat(12), {
        relevance: relevance[index],
        sourceEntryIds: [raw.id],
        tokenCount: 100,
      })
    );
    const ref = reflection('eeeeeeeeeeee', ['111111111111']);
    const entries = [
      ...raws,
      observationsRecordedEntry('om-all', { observations, coversUpToId: 'raw-5' }),
      reflectionsRecordedEntry('om-ref', { reflections: [ref], coversUpToId: 'raw-5' }),
      textCustomMessage('keep', 'tail'),
    ];
    const build = () =>
      buildCompactionProjection(entries, 'keep', { observationsPoolMaxTokens: 330 });
    const projection = build();
    expect(projection.observations.map((item) => item.id)).toEqual([
      '000000000000',
      '111111111111',
      '333333333333',
      '555555555555',
    ]);
    expect(
      projection.observations.reduce((sum, item) => sum + item.tokenCount, 0)
    ).toBeLessThanOrEqual(330);
    expect(projection.details.coveredThroughEntryId).toBe('raw-4');
    expect(projection.reflections.map((item) => item.id)).toEqual(['eeeeeeeeeeee']);
    expect(build()).toEqual(projection);
    expect(entries.some((entry) => entry.id === '000000000000')).toBe(false);
  });
});
