import { describe, expect, it } from 'vitest';
import { AGY_DEFAULT_MODEL_ID, AGY_DEFAULT_MODEL_NAME, AGY_PROVIDER_NAME } from './constants';
import { agySettingsProvider } from './settings';

describe('agySettingsProvider', () => {
  it('offers only the default model before agy has been probed', () => {
    expect(agySettingsProvider([]).models.map((model) => model.id)).toEqual([AGY_DEFAULT_MODEL_ID]);
  });

  it('labels the default model 默认 rather than the provider name', () => {
    const provider = agySettingsProvider([]);
    expect(provider.name).toBe(AGY_PROVIDER_NAME);
    expect(provider.models[0]).toEqual({ id: 'default', label: AGY_DEFAULT_MODEL_NAME });
    expect(AGY_DEFAULT_MODEL_NAME).toBe('默认');
  });

  it('keeps the default model next to the probed ones, as the worker catalog does', () => {
    // 选择器在探测前选了 agy-cli/default，Main 探测后仍要认得它，否则会话起不来、也切不过去
    const ids = agySettingsProvider([
      { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
    ]).models.map((model) => model.id);
    expect(ids).toEqual([AGY_DEFAULT_MODEL_ID, 'gemini-4-hydrogen', 'gemini-3.8-flash']);
  });
});
