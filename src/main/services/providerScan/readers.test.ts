import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readEnsoAi } from './readers';

const tmpFiles: string[] = [];

function writeTmpJson(data: unknown): string {
  const file = path.join(os.tmpdir(), `enso-test-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(file, JSON.stringify(data));
  tmpFiles.push(file);
  return file;
}

afterEach(() => {
  for (const file of tmpFiles.splice(0)) fs.rmSync(file, { force: true });
});

function ensoAiSettings(providers: unknown[]) {
  return {
    'enso-settings': {
      state: {
        claudeCodeIntegration: { enabled: false, providers },
      },
    },
  };
}

describe('readEnsoAi', () => {
  it('解析 claudeCodeIntegration.providers 为 anthropic provider', () => {
    const file = writeTmpJson(
      ensoAiSettings([
        {
          id: 'uuid-1',
          name: 'MiniMax',
          baseUrl: 'https://api.example.com/anthropic',
          authToken: 'sk-test-123',
          model: 'MiniMax-M2.1',
          smallFastModel: 'MiniMax-M2.1',
          defaultSonnetModel: 'MiniMax-M2.1',
        },
      ])
    );

    expect(readEnsoAi(file)).toEqual([
      {
        appId: 'ensoai',
        name: 'MiniMax',
        api: 'anthropic-messages',
        apiKey: 'sk-test-123',
        baseUrl: 'https://api.example.com/anthropic',
        models: [{ id: 'MiniMax-M2.1' }],
      },
    ]);
  });

  it('收集 model / default*Model / smallFastModel 并去重', () => {
    const file = writeTmpJson(
      ensoAiSettings([
        {
          name: 'multi',
          baseUrl: 'https://x.example.com',
          authToken: 'sk-a',
          model: 'opus',
          defaultOpusModel: 'big-model',
          defaultHaikuModel: 'small-model',
          smallFastModel: 'small-model',
        },
      ])
    );

    expect(readEnsoAi(file)[0].models.map((m) => m.id)).toEqual([
      'opus',
      'big-model',
      'small-model',
    ]);
  });

  it('跳过没有 authToken 的条目，保留 enabled:false 的条目', () => {
    const file = writeTmpJson(
      ensoAiSettings([
        { name: 'no-token', baseUrl: 'https://x.example.com' },
        { name: 'disabled', baseUrl: 'https://y.example.com', authToken: 'sk-b', enabled: false },
      ])
    );

    const result = readEnsoAi(file);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('disabled');
  });

  it('缺少 claudeCodeIntegration 或 providers 时返回空数组', () => {
    const file = writeTmpJson({ 'enso-settings': { state: {} } });
    expect(readEnsoAi(file)).toEqual([]);
  });
});
