import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PairedDevice } from '@enso/pair';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;
vi.mock('electron', () => ({
  app: { getPath: () => dir },
  safeStorage: { isEncryptionAvailable: () => false },
}));

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'enso-nodestore-'));
  vi.resetModules();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function store() {
  return await import('./nodeStore');
}

const cred = (pairId: string, over: Partial<PairedDevice> = {}): PairedDevice => ({
  pairId,
  token: `tok-${pairId}`,
  contentKey: 'AAAA',
  deviceName: 'my-laptop',
  relayUrl: 'https://relay.example.com',
  pairedAt: 1,
  ...over,
});

describe('节点列表纯函数', () => {
  it('upsert：新节点追加并取默认标签「节点 N」，填洞不与自定义名相撞', async () => {
    const { upsertNode } = await store();
    const a = upsertNode([], cred('p1'), undefined);
    expect(a).toHaveLength(1);
    expect(a[0].nodeId).toBe('p1');
    expect(a[0].label).toBe('节点 1');
    const b = upsertNode(a, cred('p2'), undefined);
    expect(b[1].label).toBe('节点 2');
    // 删掉 1 后再加：填回「节点 1」
    const c = upsertNode(
      b.filter((n) => n.nodeId !== 'p1'),
      cred('p3'),
      undefined
    );
    expect(c.map((n) => n.label)).toEqual(['节点 2', '节点 1']);
  });

  it('upsert：显式 label（host-info 的 hostname）优先于默认标签', async () => {
    const { upsertNode } = await store();
    const a = upsertNode([], cred('p1'), 'dev-box');
    expect(a[0].label).toBe('dev-box');
  });

  it('upsert：已有节点更新凭据但保留自定义名与位置', async () => {
    const { upsertNode, renameNode } = await store();
    let list = upsertNode([], cred('p1'), undefined);
    list = upsertNode(list, cred('p2'), undefined);
    list = renameNode(list, 'p1', '  办公室  ');
    list = upsertNode(list, cred('p1', { token: 'new-token' }), 'ignored');
    expect(list.map((n) => n.nodeId)).toEqual(['p1', 'p2']);
    expect(list[0].token).toBe('new-token');
    expect(list[0].label).toBe('办公室');
  });

  it('adoptHostname：默认「节点 N」标签被 host-info 的 hostname 替换；自定义名不动', async () => {
    const { upsertNode, renameNode, adoptHostname } = await store();
    let list = upsertNode([], cred('p1'), undefined);
    list = upsertNode(list, cred('p2'), undefined);
    list = renameNode(list, 'p2', '办公室');
    list = adoptHostname(list, 'p1', 'dev-box');
    list = adoptHostname(list, 'p2', 'other-box');
    expect(list.map((n) => n.label)).toEqual(['dev-box', '办公室']);
    // 空 hostname 不采用
    expect(adoptHostname(list, 'p1', '  ')[0].label).toBe('dev-box');
  });

  it('rename：空白名不生效', async () => {
    const { upsertNode, renameNode } = await store();
    const list = upsertNode([], cred('p1'), undefined);
    expect(renameNode(list, 'p1', '   ')[0].label).toBe('节点 1');
  });

  it('remove：按 nodeId 过滤', async () => {
    const { upsertNode, removeNode } = await store();
    let list = upsertNode([], cred('p1'), undefined);
    list = upsertNode(list, cred('p2'), undefined);
    expect(removeNode(list, 'p1').map((n) => n.nodeId)).toEqual(['p2']);
  });
});

describe('节点凭据落盘', () => {
  it('空盘读回空数组', async () => {
    const { loadNodes } = await store();
    expect(loadNodes()).toEqual([]);
  });

  it('写入后读回；与 phone-pairing.bin 分文件', async () => {
    const { saveNodes, upsertNode } = await store();
    saveNodes(upsertNode([], cred('p1'), 'dev-box'));
    vi.resetModules();
    const fresh = await store();
    expect(fresh.loadNodes().map((n) => [n.nodeId, n.label])).toEqual([['p1', 'dev-box']]);
    const { loadDevices } = await import('./pairStore');
    expect(loadDevices()).toEqual([]);
  });

  it('坏 JSON 降级为空', async () => {
    writeFileSync(path.join(dir, 'remote-nodes.bin'), 'not json');
    const { loadNodes } = await store();
    expect(loadNodes()).toEqual([]);
  });
});
