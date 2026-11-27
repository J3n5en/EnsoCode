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

  it('names the default model 默认, keeping the provider name for the provider', () => {
    const config = agyProviderConfig();
    expect(config.name).toBe('agy cli');
    expect(config.models?.[0]).toMatchObject({ id: 'default', name: '默认' });
  });
});
