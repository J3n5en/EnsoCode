import { describe, expect, it } from 'vitest';
import { containsSentinel, REMOTE_SECRET_SENTINEL, redactSecrets, restoreSecrets } from './secrets';

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
});
