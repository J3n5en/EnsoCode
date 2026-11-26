import { describe, expect, it } from 'vitest';
import {
  classifyAuthProbe,
  modelsFromSessionResult,
  modelToSet,
  nearestThinking,
  parseAgyAuthStatus,
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
