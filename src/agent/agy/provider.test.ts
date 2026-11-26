import { AGY_PLACEHOLDER_API_KEY } from '@shared/agy/constants';
import { describe, expect, it } from 'vitest';
import { agyProviderConfig } from './provider';

describe('agy provider config', () => {
  it('registers a placeholder key and always lists the default model', () => {
    expect(agyProviderConfig().apiKey).toBe(AGY_PLACEHOLDER_API_KEY);
    expect(agyProviderConfig().models?.some((model) => model.id === 'default')).toBe(true);
    expect(
      agyProviderConfig([{ id: 'gemini-x', name: 'Gemini X' }]).models?.map((model) => model.id)
    ).toEqual(['default', 'gemini-x']);
  });
});
