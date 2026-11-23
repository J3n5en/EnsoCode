import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  refreshModelDirectory: vi.fn(async () => {}),
  catalogListeners: [] as Array<() => void>,
}));

vi.mock('electron', () => ({
  app: { on: () => {} },
  ipcMain: { handle: () => {} },
}));

vi.mock('../services/modelDirectory', () => ({
  flushModelDirectoryCache: () => {},
  getModelDirectorySnapshot: () => ({ revision: 1, generatedAt: 0, providers: [] }),
  refreshModelDirectory: mocks.refreshModelDirectory,
}));

vi.mock('../services/oauthProviders', () => ({
  onOauthCatalogChanged: (listener: () => void) => {
    mocks.catalogListeners.push(listener);
    return () => {};
  },
}));

import { registerModelDirectoryHandlers } from './modelDirectory';

describe('registerModelDirectoryHandlers', () => {
  it('OAuth 模型清单变化时重算目录', () => {
    registerModelDirectoryHandlers();
    mocks.refreshModelDirectory.mockClear();

    for (const listener of mocks.catalogListeners) listener();
    expect(mocks.refreshModelDirectory).toHaveBeenCalledOnce();
  });
});
