import { isValidProxyUrl } from '@shared/proxy';
import { describe, expect, it } from 'vitest';
import {
  containsSentinel,
  REMOTE_SECRET_SENTINEL,
  redactSecrets,
  resolveProviderProbeSecret,
  restoreSecrets,
} from './secrets';

const disk = {
  'enso-settings': {
    state: {
      language: 'zh',
      searchApiKey: 'g-key',
      providers: [
        { id: 'a', apiKey: 'key-a', baseUrl: 'https://a' },
        { id: 'b', apiKey: 'key-b', baseUrl: 'https://b' },
      ],
      mcpServers: [{ id: 'm', env: { GITHUB_PAT: 'pat' }, headers: { 'X-Any': 'h' } }],
      maxTokens: 10,
      emptyToken: '',
    },
  },
};

describe('remote settings secrets', () => {
  it('redacts secret-named strings and env/header values only', () => {
    const redacted = redactSecrets(disk)['enso-settings'].state;
    expect(redacted.language).toBe('zh');
    expect(redacted.maxTokens).toBe(10);
    expect(redacted.emptyToken).toBe('');
    expect(redacted.searchApiKey).toBe(REMOTE_SECRET_SENTINEL);
    expect(redacted.providers[0]).toEqual({
      id: 'a',
      apiKey: REMOTE_SECRET_SENTINEL,
      baseUrl: 'https://a',
    });
    expect(redacted.mcpServers[0].env.GITHUB_PAT).toBe(REMOTE_SECRET_SENTINEL);
    expect(redacted.mcpServers[0].headers['X-Any']).toBe(REMOTE_SECRET_SENTINEL);
    expect(JSON.stringify(redactSecrets(disk))).not.toMatch(/key-a|key-b|pat|g-key/);
  });

  it('restores sentinels from disk, matching arrays by id after reorder', () => {
    const edited = structuredClone(redactSecrets(disk));
    const state = edited['enso-settings'].state;
    state.providers.reverse();
    state.providers.push({ id: 'c', apiKey: 'typed', baseUrl: 'https://c' });
    const restored = restoreSecrets(edited, disk)['enso-settings'].state;
    expect(restored.providers.map((p) => p.apiKey)).toEqual(['key-b', 'key-a', 'typed']);
    expect(restored.searchApiKey).toBe('g-key');
    expect(restored.mcpServers[0].env.GITHUB_PAT).toBe('pat');
    expect(containsSentinel(restored)).toBe(false);
  });

  it('never invents a secret for a sentinel without a disk counterpart', () => {
    const restored = restoreSecrets(
      { providers: [{ id: 'x', apiKey: REMOTE_SECRET_SENTINEL }] },
      {}
    );
    expect(restored.providers[0].apiKey).toBe('');
  });

  it('服务商代理地址里的账密不发给远端，原样写回时还原', () => {
    const proxied = {
      providers: [
        { id: 'p', apiKey: 'k', proxy: { mode: 'custom', url: 'http://user:pa55@127.0.0.1:7890' } },
        { id: 'q', apiKey: 'k', proxy: { mode: 'custom', url: 'http://127.0.0.1:7891' } },
      ],
    };
    const redacted = redactSecrets(proxied);
    expect(JSON.stringify(redacted)).not.toMatch(/user|pa55/);
    expect(redacted.providers[0].proxy.mode).toBe('custom');
    expect(isValidProxyUrl(redacted.providers[0].proxy.url)).toBe(true);
    expect(redacted.providers[1].proxy.url).toBe('http://127.0.0.1:7891');
    expect(restoreSecrets(redacted, proxied)).toEqual(proxied);
  });

  it('远端探测只在端点与代理都和宿主一致时回填 key 与代理账密', () => {
    const stored = {
      api: 'openai-completions',
      baseUrl: 'http://gw.local/v1',
      apiKey: 'real-key',
      proxy: { mode: 'custom', url: 'http://user:pa55@127.0.0.1:7890' },
    };
    const remote = { ...redactSecrets(stored) };
    expect(resolveProviderProbeSecret(remote, [stored])).toEqual(stored);
    const hijack = { ...remote, proxy: { mode: 'custom', url: 'http://evil.example:8080' } };
    expect(resolveProviderProbeSecret(hijack, [stored])).toMatchObject({ apiKey: '' });
    const typed = { ...hijack, apiKey: 'own-key' };
    expect(resolveProviderProbeSecret(typed, [stored])).toEqual(typed);
  });
});
