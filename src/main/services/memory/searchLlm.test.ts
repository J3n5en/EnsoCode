import { SearchLlmGate, searchLlmTimeoutMs } from '@shared/memory/searchAssist';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Complete } from './distill';
import { createSearchAssist } from './searchLlm';

const ANALYSIS = '{"intent":"factual_query","entity_terms":["Postgres"],"confidence":0.9}';

afterEach(() => {
  vi.useRealTimers();
});

function hungComplete(): { complete: Complete; signal: () => AbortSignal | undefined } {
  let signal: AbortSignal | undefined;
  const complete: Complete = (_system, _user, options) =>
    new Promise((_resolve, reject) => {
      signal = options?.signal;
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  return { complete, signal: () => signal };
}

describe('createSearchAssist budgets', () => {
  it('aborts a local call at 1500ms', async () => {
    vi.useFakeTimers();
    const { complete, signal } = hungComplete();
    const assist = createSearchAssist(complete, { gate: new SearchLlmGate() });
    const pending = assist!.analyze('local model');
    await vi.advanceTimersByTimeAsync(1499);
    expect(signal()?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeNull();
    expect(signal()?.aborted).toBe(true);
    expect(assist!.outcome?.()).toEqual({ assist: 'fallback', assistReason: 'timeout' });
  });

  it('waits 8000ms before aborting a remote call', async () => {
    vi.useFakeTimers();
    const { complete, signal } = hungComplete();
    complete.searchTimeoutMs = searchLlmTimeoutMs('remote');
    const assist = createSearchAssist(complete, { gate: new SearchLlmGate() });
    const pending = assist!.analyze('remote model');
    await vi.advanceTimersByTimeAsync(1500);
    expect(signal()?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(6500);
    await expect(pending).resolves.toBeNull();
    expect(signal()?.aborted).toBe(true);
    expect(assist!.outcome?.()).toEqual({ assist: 'fallback', assistReason: 'timeout' });
  });
});

describe('createSearchAssist outcome', () => {
  it('reports llm when a step parses', async () => {
    const assist = createSearchAssist(async () => ANALYSIS, { gate: new SearchLlmGate() });
    await expect(assist!.analyze('Postgres')).resolves.toMatchObject({ intent: 'factual' });
    expect(assist!.outcome?.()).toEqual({ assist: 'llm' });
  });

  it('reports llm when rerank succeeds after analysis is unparseable', async () => {
    let step = 0;
    const assist = createSearchAssist(
      async () => {
        step += 1;
        return step === 1 ? 'nope' : '{"scores":[4]}';
      },
      { gate: new SearchLlmGate() }
    );
    await assist!.analyze('Postgres');
    await assist!.rerank('Postgres', [{ title: 'Postgres', content: 'primary db' }]);
    expect(assist!.outcome?.()).toEqual({ assist: 'llm' });
  });

  it('reports unparseable without opening the backoff window', async () => {
    const gate = new SearchLlmGate();
    let calls = 0;
    const assist = createSearchAssist(
      async () => {
        calls += 1;
        return 'not json';
      },
      { gate }
    );
    await assist!.analyze('Postgres');
    expect(assist!.outcome?.()).toEqual({ assist: 'fallback', assistReason: 'unparseable' });
    await assist!.analyze('Postgres');
    expect(calls).toBe(2);
  });

  it('reports error, then backoff while the gate is closed', async () => {
    const gate = new SearchLlmGate(30_000, () => 0);
    let calls = 0;
    const complete: Complete = async () => {
      calls += 1;
      throw new Error('boom');
    };
    const first = createSearchAssist(complete, { gate });
    await first!.analyze('Postgres');
    expect(first!.outcome?.()).toEqual({ assist: 'fallback', assistReason: 'error' });
    const second = createSearchAssist(complete, { gate });
    await second!.analyze('Postgres');
    expect(calls).toBe(1);
    expect(second!.outcome?.()).toEqual({ assist: 'fallback', assistReason: 'backoff' });
  });
});
