import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 每个用例一个独立 userData 目录，避免相互串扰 */
let dir: string;
vi.mock('electron', () => ({
  app: { getPath: () => dir },
  safeStorage: { isEncryptionAvailable: () => false },
}));

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'enso-pairstore-'));
  // pairStore 内有模块级设备缓存，不重置会跨用例串
  vi.resetModules();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function store() {
  return await import('./pairStore');
}

describe('中继地址持久化', () => {
  it('没写过时返回 null，由调用方回落默认值', async () => {
    const { loadRelayUrl } = await store();
    expect(loadRelayUrl()).toBeNull();
  });

  it('写入后能读回', async () => {
    const { loadRelayUrl, saveRelayUrl } = await store();
    saveRelayUrl('https://relay.example.com');
    expect(loadRelayUrl()).toBe('https://relay.example.com');
  });

  it('清空（null）后读回 null，等于恢复默认', async () => {
    const { loadRelayUrl, saveRelayUrl } = await store();
    saveRelayUrl('https://relay.example.com');
    saveRelayUrl(null);
    expect(loadRelayUrl()).toBeNull();
  });

  it('文件损坏不抛错，按未设置处理', async () => {
    const { loadRelayUrl } = await store();
    writeFileSync(path.join(dir, 'phone-relay.json'), '{ not json');
    expect(loadRelayUrl()).toBeNull();
  });

  it('字段类型不对也按未设置处理', async () => {
    const { loadRelayUrl } = await store();
    writeFileSync(path.join(dir, 'phone-relay.json'), JSON.stringify({ relayUrl: 42 }));
    expect(loadRelayUrl()).toBeNull();
  });

  it('不写进凭据文件，两者互不影响', async () => {
    const { loadDevices, saveRelayUrl } = await store();
    saveRelayUrl('https://relay.example.com');
    expect(loadDevices()).toEqual([]);
  });
});
