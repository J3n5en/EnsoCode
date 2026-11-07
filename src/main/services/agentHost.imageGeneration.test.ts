import { EventEmitter } from 'node:events';
import type { ModelProvider } from '@shared/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  fork: vi.fn(),
}));
vi.mock('electron', async (original) => ({
  ...(await original<typeof import('electron')>()),
  utilityProcess: { fork: fixture.fork },
}));
vi.mock('../ipc/settings', async (original) => ({
  ...(await original<typeof import('../ipc/settings')>()),
  readSettings: () => fixture.settings,
}));
vi.mock('./modelDirectory', () => ({
  getModelDirectorySnapshot: () => ({ revision: 0, generatedAt: 0, providers: [] }),
  onModelDirectoryChanged: () => () => {},
}));

import * as host from './agentHost';

const provider: ModelProvider = {
  id: 'image-provider',
  name: 'Images',
  api: 'openai-responses',
  catalogId: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'fixture-secret',
  enabled: true,
  models: [{ id: 'image-model', imageGeneration: true }],
};

function settings(providers: ModelProvider[], selected = true) {
  fixture.settings = {
    'enso-settings': {
      version: 14,
      state: {
        providers,
        imageGenerationModel: selected ? { providerId: provider.id, modelId: 'image-model' } : null,
      },
    },
  };
}

function start() {
  const worker = Object.assign(new EventEmitter(), {
    postMessage: vi.fn(),
    kill: vi.fn(() => true),
  });
  fixture.fork.mockReturnValue(worker);
  host.startAgentWorker();
  return worker;
}

afterEach(() => {
  host.stopAgentWorker();
  vi.clearAllMocks();
});

describe('Main 生图配置推送', () => {
  it('worker ready 补发默认生图模型，不依赖聊天模型初始化', () => {
    settings([provider]);
    const worker = start();
    expect(worker.postMessage).not.toHaveBeenCalled();
    worker.emit('spawn');
    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'set-image-generation-config',
      config: {
        providerId: provider.id,
        modelId: 'image-model',
        protocol: 'openai',
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
      },
    });
  });

  it('配置撤销或失效时显式清空旧模型；后续恢复使用新凭据', () => {
    settings([provider]);
    const worker = start();
    worker.emit('spawn');
    for (const entry of [
      { ...provider, enabled: false },
      { ...provider, models: [{ id: 'image-model', imageGeneration: false }] },
      { ...provider, apiKey: '' },
      { ...provider, models: [] },
      { ...provider, models: null } as unknown as ModelProvider,
      { ...provider, models: [null] } as unknown as ModelProvider,
      { ...provider, apiKey: 123 } as unknown as ModelProvider,
    ]) {
      settings([entry]);
      host.pushImageGenerationConfig();
      expect(worker.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
        type: 'set-image-generation-config',
        config: null,
      });
    }
    settings([provider], false);
    host.pushImageGenerationConfig();
    expect(worker.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ config: null });
    settings([{ ...provider, apiKey: 'new-fixture-key' }]);
    host.pushImageGenerationConfig();
    expect(worker.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
      config: { apiKey: 'new-fixture-key' },
    });
  });
});
