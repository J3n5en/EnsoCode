import type { ListModelsResult, ModelProvider, ProviderApiConfig } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderModelRefresh } from './providerModelRefresh';

const hour = 60 * 60 * 1000;

function provider(id: string, fields: Partial<ModelProvider> = {}): ModelProvider {
  return {
    id,
    name: id,
    api: 'openai-completions',
    apiKey: 'example-key',
    baseUrl: `https://${id}.example/v1`,
    enabled: true,
    autoFetchModels: true,
    models: [],
    ...fields,
  };
}

function setup(providers: ModelProvider[]) {
  let state: Record<string, unknown> = { providers };
  const fetchModels =
    vi.fn<(config: ProviderApiConfig, signal: AbortSignal) => Promise<ListModelsResult>>();
  const writeProviders = vi.fn((next: unknown[]) => {
    state = { ...state, providers: next };
    refresh.sync();
  });
  const refresh = createProviderModelRefresh({
    readSettingsState: () => state,
    writeProviders,
    fetchModels,
  });
  return {
    refresh,
    fetchModels,
    writeProviders,
    get providers() {
      return state.providers;
    },
    setProviders(next: ModelProvider[]) {
      state = { ...state, providers: next };
    },
    setAutoFetch(id: string, value: unknown) {
      state = {
        ...state,
        providers: (state.providers as ModelProvider[]).map((entry) =>
          entry.id === id ? { ...entry, autoFetchModels: value } : entry
        ),
      };
      refresh.sync();
    },
    setIntervalHours(id: string, value: unknown) {
      state = {
        ...state,
        providers: (state.providers as ModelProvider[]).map((entry) =>
          entry.id === id ? { ...entry, modelRefreshIntervalHours: value } : entry
        ),
      };
      refresh.sync();
    },
  };
}

describe('scheduled API-key provider model refresh', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts only opted-in entries and cancels independently at the same endpoint', async () => {
    const first = provider('first');
    const second = provider('second', {
      baseUrl: first.baseUrl,
      apiKey: 'another-key',
      autoFetchModels: false,
    });
    const app = setup([first, second]);
    const firstResult = Promise.withResolvers<ListModelsResult>();
    const secondResult = Promise.withResolvers<ListModelsResult>();
    app.fetchModels
      .mockReturnValueOnce(firstResult.promise)
      .mockReturnValueOnce(secondResult.promise);
    app.refresh.sync();
    expect(app.fetchModels).toHaveBeenCalledTimes(1);
    const enabledSecond = { ...second, autoFetchModels: true };
    app.setProviders([first, enabledSecond]);
    app.refresh.sync();
    expect(app.fetchModels).toHaveBeenCalledTimes(2);

    const closedFirst = { ...first, autoFetchModels: false };
    app.setProviders([closedFirst, enabledSecond]);
    app.refresh.sync();
    expect(app.fetchModels.mock.calls.map(([, signal]) => signal.aborted)).toEqual([true, false]);
    firstResult.resolve({ ok: true, models: [{ id: 'obsolete' }] });
    secondResult.resolve({ ok: true, models: [{ id: 'current' }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(app.providers).toEqual([
      closedFirst,
      { ...enabledSecond, models: [{ id: 'current', enabled: true }] },
    ]);
  });

  it('is off by default and enables immediately, then once per hour', async () => {
    const app = setup([provider('chat', { autoFetchModels: undefined })]);
    app.fetchModels.mockResolvedValue({ ok: true, models: [] });
    app.refresh.sync();
    app.setAutoFetch('chat', 'true');
    await vi.advanceTimersByTimeAsync(hour);
    expect(app.fetchModels).not.toHaveBeenCalled();

    app.setAutoFetch('chat', true);
    expect(app.fetchModels).toHaveBeenCalledTimes(1);
    app.refresh.sync();
    await vi.advanceTimersByTimeAsync(hour - 1);
    expect(app.fetchModels).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(app.fetchModels).toHaveBeenCalledTimes(2);
    app.refresh.stop();
    await vi.advanceTimersByTimeAsync(hour);
    expect(app.fetchModels).toHaveBeenCalledTimes(2);
  });

  it('runs each saved interval independently and keeps deadlines on repeated sync', async () => {
    const app = setup([provider('chat', { modelRefreshIntervalHours: 3 }), provider('other')]);
    const attempts = () =>
      app.fetchModels.mock.calls.map(([config]) => new URL(config.baseUrl).hostname);
    app.fetchModels.mockResolvedValue({ ok: true, models: [] });
    app.refresh.sync();
    expect(attempts()).toEqual(['chat.example', 'other.example']);
    await vi.advanceTimersByTimeAsync(2 * hour);
    app.refresh.sync();
    await vi.advanceTimersByTimeAsync(hour - 1);
    expect(attempts()).toEqual(['chat.example', 'other.example', 'other.example', 'other.example']);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts().slice(-2)).toEqual(['chat.example', 'other.example']);
  });

  it('restarts the countdown on an interval edit and lets the active request finish', async () => {
    const other = provider('other');
    const app = setup([provider('chat'), other]);
    const result = Promise.withResolvers<ListModelsResult>();
    app.fetchModels.mockReturnValueOnce(result.promise).mockResolvedValue({ ok: true, models: [] });
    const attempts = (id: string) =>
      app.fetchModels.mock.calls.filter(([config]) => config.baseUrl.includes(`${id}.example`))
        .length;
    app.refresh.sync();
    const signal = app.fetchModels.mock.calls[0]?.[1];
    await vi.advanceTimersByTimeAsync(hour / 2);
    app.setIntervalHours('chat', 2);
    expect(attempts('chat')).toBe(1);
    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(hour);
    expect(attempts('other')).toBe(2);
    result.resolve({ ok: true, models: [{ id: 'found' }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(app.providers).toEqual([
      provider('chat', { modelRefreshIntervalHours: 2, models: [{ id: 'found', enabled: true }] }),
      other,
    ]);
    await vi.advanceTimersByTimeAsync(hour - 1);
    expect(attempts('chat')).toBe(1);
    expect(attempts('other')).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts('chat')).toBe(2);
    expect(attempts('other')).toBe(3);
  });

  it('saves the interval while disabled and uses it on the next enable', async () => {
    const app = setup([provider('chat', { autoFetchModels: false })]);
    app.fetchModels.mockResolvedValue({ ok: true, models: [] });
    app.setIntervalHours('chat', 4);
    await vi.advanceTimersByTimeAsync(4 * hour);
    expect(app.fetchModels).not.toHaveBeenCalled();

    app.setAutoFetch('chat', true);
    expect(app.fetchModels).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4 * hour - 1);
    expect(app.fetchModels).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(app.fetchModels).toHaveBeenCalledTimes(2);
    app.setAutoFetch('chat', false);
    await vi.advanceTimersByTimeAsync(4 * hour);
    expect(app.fetchModels).toHaveBeenCalledTimes(2);
  });

  it.each([0, 169, '12', 1.5, null])(
    'uses the default hour for invalid stored interval %j',
    async (hours) => {
      const app = setup([provider('chat')]);
      app.fetchModels.mockResolvedValue({ ok: true, models: [] });
      app.setIntervalHours('chat', hours);
      await vi.advanceTimersByTimeAsync(hour - 1);
      expect(app.fetchModels).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(app.fetchModels).toHaveBeenCalledTimes(2);
    }
  );

  it('appends new IDs with their metadata and writes only when the list grows', async () => {
    const original = provider('chat', {
      models: [
        { id: 'manual', label: 'My model' },
        { id: 'disabled', enabled: false, contextWindow: 321 },
      ],
    });
    const app = setup([original]);
    app.fetchModels.mockResolvedValue({
      ok: true,
      models: [
        { id: 'disabled', contextWindow: 999 },
        { id: 'new', maxTokens: 4096 },
      ],
    });
    app.refresh.sync();
    await vi.advanceTimersByTimeAsync(0);
    expect(app.providers).toEqual([
      { ...original, models: [...original.models, { id: 'new', enabled: true, maxTokens: 4096 }] },
    ]);
    await vi.advanceTimersByTimeAsync(hour);
    app.fetchModels.mockResolvedValue({ ok: true, models: [] });
    await vi.advanceTimersByTimeAsync(hour);
    expect(app.writeProviders).toHaveBeenCalledTimes(1);
  });

  it('skips ineligible entries and keeps refreshing other providers after a failure', async () => {
    using warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = setup([
      provider('disabled', { enabled: false }),
      provider('oauth', { oauthAccountKey: 'oauth' }),
      provider('pool', { oauthAccountPool: { accountKeys: ['oauth', 'another'] } }),
      provider('empty', { apiKey: '   ' }),
      { ...provider('unknown'), api: 'invalid' } as unknown as ModelProvider,
      provider('classifier', { catalogId: 'typesafe' }),
      provider('unavailable'),
      provider('failed'),
      provider('chat', { headers: { 'X-Tenant': 'test' } }),
    ]);
    app.fetchModels
      .mockResolvedValueOnce({ ok: false, models: [], error: 'HTTP 404' })
      .mockRejectedValueOnce(new Error('failed'))
      .mockResolvedValueOnce({ ok: true, models: [{ id: 'new' }] });
    app.refresh.sync();
    await vi.advanceTimersByTimeAsync(0);
    expect(warning.mock.calls).toEqual([
      ['[provider-model-refresh] model list failed'],
      ['[provider-model-refresh] model list failed'],
    ]);
    expect(app.fetchModels.mock.calls.map(([config]) => config.baseUrl)).toEqual([
      'https://unavailable.example/v1',
      'https://failed.example/v1',
      'https://chat.example/v1',
    ]);
    expect(app.fetchModels.mock.calls[2]?.[0].headers).toEqual({ 'X-Tenant': 'test' });
    expect(app.providers).toEqual([
      ...(app.providers as ModelProvider[]).slice(0, -2),
      provider('failed'),
      provider('chat', { headers: { 'X-Tenant': 'test' }, models: [{ id: 'new', enabled: true }] }),
    ]);
  });

  it.each([
    { baseUrl: 'https://other.example/v1' },
    { apiKey: 'different-key' },
    { headers: { 'X-Tenant': 'other' } },
    { enabled: false },
    { autoFetchModels: false },
    null,
  ])('discards in-flight results after provider changes (%j)', async (change) => {
    const app = setup([provider('chat')]);
    const result = Promise.withResolvers<ListModelsResult>();
    app.fetchModels.mockReturnValue(result.promise);
    app.refresh.sync();
    app.setProviders(change ? [provider('chat', change)] : []);
    result.resolve({ ok: true, models: [{ id: 'obsolete' }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(app.writeProviders).not.toHaveBeenCalled();
  });

  it('cancels an obsolete request immediately and keeps the latest result for the same id', async () => {
    const first = Promise.withResolvers<ListModelsResult>();
    const other = Promise.withResolvers<ListModelsResult>();
    const replacement = Promise.withResolvers<ListModelsResult>();
    const app = setup([provider('chat'), provider('other')]);
    app.fetchModels
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(other.promise)
      .mockReturnValueOnce(replacement.promise);
    app.refresh.sync();
    const changed = provider('chat', { headers: { 'X-Tenant': 'new' } });
    app.setProviders([changed, provider('other')]);
    app.refresh.sync();
    expect(app.fetchModels.mock.calls[0]?.[1].aborted).toBe(true);
    expect(app.fetchModels.mock.calls[1]?.[1].aborted).toBe(false);
    expect(app.fetchModels.mock.calls[2]?.[0].headers).toEqual({ 'X-Tenant': 'new' });

    first.resolve({ ok: true, models: [{ id: 'obsolete' }] });
    other.resolve({ ok: true, models: [{ id: 'other-found' }] });
    replacement.resolve({ ok: true, models: [{ id: 'replacement-found' }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(app.providers).toEqual([
      { ...changed, models: [{ id: 'replacement-found', enabled: true }] },
      provider('other', { models: [{ id: 'other-found', enabled: true }] }),
    ]);
  });

  it('does not overlap a cycle and aborts and ignores late results on disable', async () => {
    const app = setup([provider('chat')]);
    const result = Promise.withResolvers<ListModelsResult>();
    app.fetchModels.mockReturnValue(result.promise);
    app.refresh.sync();
    const signal = app.fetchModels.mock.calls[0]?.[1];
    await vi.advanceTimersByTimeAsync(2 * hour);
    expect(app.fetchModels).toHaveBeenCalledTimes(1);
    app.setAutoFetch('chat', false);
    expect(signal?.aborted).toBe(true);
    result.resolve({ ok: true, models: [{ id: 'obsolete' }] });
    await vi.advanceTimersByTimeAsync(hour);
    expect(app.writeProviders).not.toHaveBeenCalled();
    expect(app.fetchModels).toHaveBeenCalledTimes(1);
  });

  it('merges into the latest provider list after concurrent user edits', async () => {
    const app = setup([provider('chat'), provider('deleted')]);
    const result = Promise.withResolvers<ListModelsResult>();
    app.fetchModels.mockReturnValueOnce(result.promise).mockResolvedValue({ ok: true, models: [] });
    app.refresh.sync();
    const renamed = provider('chat', { name: 'Renamed', models: [{ id: 'manual' }] });
    const added = provider('added');
    app.setProviders([added, renamed]);
    app.refresh.sync();
    expect(app.fetchModels.mock.calls[1]?.[1].aborted).toBe(true);
    expect(app.fetchModels.mock.calls[2]?.[0].baseUrl).toBe(added.baseUrl);
    result.resolve({ ok: true, models: [{ id: 'new' }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(app.providers).toEqual([
      added,
      { ...renamed, models: [{ id: 'manual' }, { id: 'new', enabled: true }] },
    ]);
  });
});
