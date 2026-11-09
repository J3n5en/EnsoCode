import { STATIC_PROVIDER_DEFINITIONS } from '@shared/providerCatalog';
import { describe, expect, it } from 'vitest';
import { resolveProviderLogo } from './providerLogos';

describe('向导厂商 logo', () => {
  it('Custom 不挂品牌标', () => {
    expect(resolveProviderLogo('__custom', 'Custom')).toBeNull();
  });

  it('静态厂商（除 Custom）都有标：品牌 path 或字母兜底', () => {
    for (const definition of STATIC_PROVIDER_DEFINITIONS) {
      if (definition.id === '__custom') continue;
      const logo = resolveProviderLogo(definition.id, definition.label);
      expect(logo, definition.id).not.toBeNull();
      expect(logo?.kind === 'mark' || logo?.kind === 'letter').toBe(true);
    }
  });

  it('订阅扩展 id 复用对应厂商标', () => {
    const openai = resolveProviderLogo('openai', 'OpenAI');
    const google = resolveProviderLogo('google', 'Google');
    const moonshot = resolveProviderLogo('moonshot', 'Moonshot');
    expect(resolveProviderLogo('openai-codex', 'OpenAI Codex')).toEqual(openai);
    expect(resolveProviderLogo('google-antigravity', 'Google Antigravity')).toEqual(google);
    expect(resolveProviderLogo('google-vertex', 'Google Vertex')).toEqual(google);
    expect(resolveProviderLogo('kimi-coding', 'Kimi')).toEqual(moonshot);
    expect(resolveProviderLogo('github-copilot', 'GitHub Copilot')?.kind).toBe('mark');
    expect(resolveProviderLogo('cursor', 'Cursor')?.kind).toBe('mark');
    expect(resolveProviderLogo('devin', 'Devin')?.kind).toBe('mark');
    expect(resolveProviderLogo('zai', 'Z.AI')).toEqual(resolveProviderLogo('zhipu', 'Zhipu AI'));
  });

  it('未知扩展厂商用展示名首字母，没有名称时用 id', () => {
    expect(resolveProviderLogo('acme-labs', 'Acme Labs')).toEqual({ kind: 'letter', letter: 'A' });
    expect(resolveProviderLogo('9lives')).toEqual({ kind: 'letter', letter: '9' });
  });

  it('Qoder-CN 和 Qoder 共用品牌标', () => {
    const logo = resolveProviderLogo('qoder', 'Qoder');
    expect(logo?.kind).toBe('mark');
    expect(resolveProviderLogo('qoder-cn', 'Qoder-CN')).toEqual(logo);
  });
});
