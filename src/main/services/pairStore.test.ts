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

const cred = (pairId: string, over: Record<string, unknown> = {}) => ({
  pairId,
  token: `tok-${pairId}`,
  contentKey: 'AAAA',
  deviceName: 'iPhone',
  relayUrl: 'https://relay.example.com',
  pairedAt: 1,
  ...over,
});

describe('已配对设备改名', () => {
  it('按 pairId 改 deviceName 并 trim', async () => {
    const { upsertDevice, renameDevice } = await store();
    const list = upsertDevice([], cred('p1'));
    const next = renameDevice(list, 'p1', '  家里的手机  ');
    expect(next[0].deviceName).toBe('家里的手机');
  });

  it('空白名不生效', async () => {
    const { upsertDevice, renameDevice } = await store();
    const list = upsertDevice([], cred('p1'));
    expect(renameDevice(list, 'p1', '   ')[0].deviceName).toBe('iPhone');
  });

  it('重配对更新凭据但保留自定义名与位置', async () => {
    const { upsertDevice, renameDevice } = await store();
    let list = upsertDevice([], cred('p1'));
    list = upsertDevice(list, cred('p2', { deviceName: 'Pixel' }));
    list = renameDevice(list, 'p1', '家里的手机');
    list = upsertDevice(list, cred('p1', { token: 'new-token', deviceName: 'iPhone 16' }));
    expect(list.map((d) => d.pairId)).toEqual(['p1', 'p2']);
    expect(list[0].token).toBe('new-token');
    expect(list[0].deviceName).toBe('家里的手机');
  });
});

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
