import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/unused-user-data' },
}));

import {
  __setChatModelsRootForTest,
  deleteChatModel,
  listChatModels,
  setChatSlotReleaser,
  startChatModelDownload,
} from './chatModels';

afterEach(() => {
  __setChatModelsRootForTest(null);
  setChatSlotReleaser(null);
});

describe('chat model manager', () => {
  it('lists remote as ready and Gemma as missing until the ready marker exists', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'enso-chat-mgr-'));
    __setChatModelsRootForTest(root);
    const listed = listChatModels();
    expect(listed.find((m) => m.id === 'remote')).toMatchObject({
      downloadable: false,
      state: 'ready',
    });
    expect(listed.find((m) => m.id === 'local:gemma-4-e2b')).toMatchObject({
      downloadable: true,
      state: 'missing',
    });

    const dir = path.join(root, 'local_gemma-4-e2b');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'gemma-4-E2B-it-UD-Q4_K_XL.gguf'), 'gguf');
    writeFileSync(path.join(dir, '.ready'), '');
    expect(listChatModels().find((m) => m.id === 'local:gemma-4-e2b')?.state).toBe('ready');
  });

  it('refuses to download unknown or remote ids', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'enso-chat-mgr-'));
    __setChatModelsRootForTest(root);
    expect(await startChatModelDownload('remote')).toBe(false);
    expect(await startChatModelDownload('local:nope')).toBe(false);
    expect(await startChatModelDownload('')).toBe(false);
  });

  it('deletes only a known downloadable model directory', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'enso-chat-mgr-'));
    __setChatModelsRootForTest(root);
    expect(await deleteChatModel('remote')).toBe(false);
    expect(await deleteChatModel('local:nope')).toBe(false);

    const dir = path.join(root, 'local_gemma-4-e2b');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'gemma-4-E2B-it-UD-Q4_K_XL.gguf'), 'gguf');
    writeFileSync(path.join(dir, '.ready'), '');
    expect(await deleteChatModel('local:gemma-4-e2b')).toBe(true);
    expect(listChatModels().find((m) => m.id === 'local:gemma-4-e2b')?.state).toBe('missing');
  });

  it('waits for the chat slot to release before removing files', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'enso-chat-mgr-'));
    __setChatModelsRootForTest(root);
    const dir = path.join(root, 'local_gemma-4-e2b');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'gemma-4-E2B-it-UD-Q4_K_XL.gguf'), 'gguf');
    writeFileSync(path.join(dir, '.ready'), '');

    let released = false;
    setChatSlotReleaser(async () => {
      expect(existsSync(dir)).toBe(true);
      released = true;
    });
    expect(await deleteChatModel('local:gemma-4-e2b')).toBe(true);
    expect(released).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });
});
