import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveRunProvider, writeProviderSettings } from './provider';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const saved = {
  id: 'saved',
  name: 'Saved',
  api: 'openai-completions',
  apiKey: 'old',
  baseUrl: 'https://saved.example/v1',
  enabled: true,
  models: [{ id: 'saved-model' }],
};

describe('resolveRunProvider', () => {
  it('creates a provider from flags and infers an Anthropic endpoint', () => {
    const resolved = resolveRunProvider(
      {
        modelId: 'claude',
        apiKey: 'key',
        baseUrl: 'https://api.anthropic.com',
      },
      [saved, { nope: true }]
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.providerId).toBe('enso-run');
    expect(resolved.value.modelId).toBe('claude');
    expect(resolved.value.changed).toBe(true);
    const created = resolved.value.providers.at(-1) as { api: string; apiKey: string };
    expect(created.api).toBe('anthropic-messages');
    expect(created.apiKey).toBe('key');
    expect(resolved.value.providers[1]).toEqual({ nope: true });
  });

  it('uses an existing provider and appends a model that is not listed yet', () => {
    const resolved = resolveRunProvider({ providerId: 'saved', modelId: 'new-model' }, [saved]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value).toMatchObject({
      providerId: 'saved',
      modelId: 'new-model',
      changed: true,
    });
    expect(resolved.value.providers).toEqual([
      { ...saved, models: [{ id: 'saved-model' }, { id: 'new-model' }] },
    ]);
  });

  it('reports a missing endpoint instead of inventing a key', () => {
    expect(resolveRunProvider({ modelId: 'm', baseUrl: 'http://127.0.0.1/v1' }, []).ok).toBe(false);
    expect(resolveRunProvider({}, []).ok).toBe(false);
    expect(resolveRunProvider({ providerId: 'missing' }, [saved]).ok).toBe(false);
  });

  it('uses the protocol default base URL when only a key is given', () => {
    const resolved = resolveRunProvider(
      { modelId: 'claude', apiKey: 'key', api: 'anthropic-messages' },
      []
    );
    expect(resolved.ok && resolved.value.providers[0]).toMatchObject({
      api: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
    });
  });

  it('writes settings as owner-only and keeps unrelated state', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'enso-run-settings-'));
    dirs.push(dir);
    const file = path.join(dir, 'settings.json');
    writeProviderSettings(file, [saved]);
    chmodSync(file, 0o644);
    writeProviderSettings(file, [saved]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    expect(stored['enso-settings'].state.providers).toEqual([saved]);
  });
});
