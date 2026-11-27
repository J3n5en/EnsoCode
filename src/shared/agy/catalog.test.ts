import { describe, expect, it } from 'vitest';
import {
  classifyAuthProbe,
  modelsFromSessionResult,
  modelToSet,
  nearestThinking,
  offeredAgyModels,
  parseAgyAuthStatus,
  parseAgyModels,
} from './catalog';

const session = {
  sessionId: 's1',
  models: {
    availableModels: [{ modelId: 'gemini-4-hydrogen-high', name: 'Gemini 4 Hydrogen (High)' }],
  },
  configOptions: [
    {
      id: 'model',
      type: 'select',
      currentValue: 'gemini-4-hydrogen',
      options: [
        { value: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
        { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      ],
    },
    {
      id: 'thought_level',
      category: 'thought_level',
      type: 'select',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
        { value: 'xhigh', name: 'Extra' },
      ],
    },
  ],
};

describe('agy catalog', () => {
  it('classifies the probe without returning account data', () => {
    expect(classifyAuthProbe({ found: false })).toEqual({ status: 'not-installed' });
    expect(classifyAuthProbe({ found: true, version: '1.4.0' })).toEqual({
      status: 'too-old',
      version: '1.4.0',
    });
    expect(
      classifyAuthProbe({ found: true, version: '1.5.18', sessionId: 's1', result: session })
    ).toEqual({
      status: 'signed-in',
      version: '1.5.18',
      models: [
        { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
        { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      ],
    });
    expect(
      classifyAuthProbe({ found: true, version: '1.5.18', errorCode: -32000, errorMessage: 'nope' })
    ).toEqual({ status: 'signed-out', version: '1.5.18' });
    expect(
      classifyAuthProbe({
        found: true,
        version: '1.5.18',
        errorCode: -32603,
        errorMessage: 'No browser is available here for login',
      })
    ).toEqual({ status: 'signed-out', version: '1.5.18' });
    expect(classifyAuthProbe({ found: true, version: '1.5.18', timedOut: true })).toEqual({
      status: 'unknown',
    });
  });

  it('does not set the default model, and maps thinking to the nearest offered value', () => {
    expect(modelToSet('default', modelsFromSessionResult(session))).toBeUndefined();
    expect(modelToSet('agy-cli/default', modelsFromSessionResult(session))).toBeUndefined();
    expect(modelToSet('gemini-3.8-flash', modelsFromSessionResult(session))).toBe(
      'gemini-3.8-flash'
    );
    expect(nearestThinking('off', ['low', 'medium', 'high', 'xhigh'])).toBe('low');
    expect(nearestThinking('max', ['low', 'medium', 'high', 'xhigh'])).toBe('xhigh');
    expect(nearestThinking('medium', ['low', 'medium', 'high', 'xhigh'])).toBe('medium');
  });
});

describe('parseAgyAuthStatus', () => {
  it('keeps a well-formed status and drops anything else to unknown', () => {
    expect(
      parseAgyAuthStatus({
        status: 'signed-in',
        version: '1.5.18',
        models: [{ id: 'm', name: 'M' }, { id: '' }, 3],
      })
    ).toEqual({ status: 'signed-in', version: '1.5.18', models: [{ id: 'm', name: 'M' }] });
    expect(parseAgyAuthStatus({ status: 'signed-out', version: '1.5.18' })).toEqual({
      status: 'signed-out',
      version: '1.5.18',
    });
    expect(parseAgyAuthStatus({ status: 'not-installed' })).toEqual({ status: 'not-installed' });
    for (const bad of [
      null,
      undefined,
      'signed-in',
      {},
      { status: 'signed-in' },
      { status: 'x' },
    ]) {
      expect(parseAgyAuthStatus(bad)).toEqual({ status: 'unknown' });
    }
  });
});

describe('parseAgyModels', () => {
  it('keeps well-formed entries and treats any other shape as an empty list', () => {
    expect(parseAgyModels([{ id: 'm', name: 'M' }, { id: 'n' }, { id: '' }, 3, null])).toEqual([
      { id: 'm', name: 'M' },
      { id: 'n', name: 'n' },
    ]);
    for (const bad of [null, undefined, 'm', {}, { models: [] }, 7]) {
      expect(parseAgyModels(bad)).toEqual([]);
    }
  });
});

describe('offeredAgyModels', () => {
  const persisted = [{ id: 'old', name: 'Old' }];

  it('uses the live list after a signed-in probe', () => {
    const live = [{ id: 'new', name: 'New' }];
    expect(
      offeredAgyModels({ status: 'signed-in', version: '1.5.18', models: live }, persisted)
    ).toEqual(live);
  });

  it('falls back to the persisted list while the status is unknown', () => {
    expect(offeredAgyModels({ status: 'unknown' }, persisted)).toEqual(persisted);
    expect(offeredAgyModels({ status: 'unknown' }, [])).toEqual([]);
  });

  it('offers nothing beyond the default once agy is known to be unavailable', () => {
    expect(offeredAgyModels({ status: 'signed-out', version: '1.5.18' }, persisted)).toEqual([]);
    expect(offeredAgyModels({ status: 'not-installed' }, persisted)).toEqual([]);
    expect(offeredAgyModels({ status: 'too-old', version: '1.4.0' }, persisted)).toEqual([]);
  });
});
