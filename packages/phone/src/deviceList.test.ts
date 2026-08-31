import type { PairedDevice } from '@enso/pair';
import { describe, expect, it } from 'vitest';
import { migrateStore, pickActive, removeDevice, renameDevice, upsertDevice } from './deviceList';

const paired = (over: Partial<PairedDevice> = {}): PairedDevice => ({
  pairId: 'p1',
  token: 't',
  contentKey: 'k',
  deviceName: 'iPhone',
  relayUrl: 'https://relay',
  pairedAt: 1,
  ...over,
});

describe('migrateStore', () => {
  it('无任何存量返回空列表', () => {
    expect(migrateStore(null, null)).toEqual([]);
  });

  it('只有旧单配对键：迁移成一台，默认名「电脑 1」', () => {
    const list = migrateStore(null, JSON.stringify(paired()));
    expect(list).toHaveLength(1);
    expect(list[0].pairId).toBe('p1');
    expect(list[0].label).toBe('电脑 1');
  });

  it('新列表键优先，忽略旧键；坏 JSON 降级为空', () => {
    const stored = JSON.stringify([{ ...paired({ pairId: 'p2' }), label: '工作机' }]);
    const list = migrateStore(stored, JSON.stringify(paired()));
    expect(list).toHaveLength(1);
    expect(list[0].pairId).toBe('p2');
    expect(migrateStore('not-json', null)).toEqual([]);
  });
});

describe('upsertDevice', () => {
  it('新增取最小可用默认名：电脑 1、电脑 2…', () => {
    const one = upsertDevice([], paired());
    expect(one[0].label).toBe('电脑 1');
    const two = upsertDevice(one, paired({ pairId: 'p2' }));
    expect(two[1].label).toBe('电脑 2');
  });

  it('默认名有洞时填洞不撞名', () => {
    const list = [
      { ...paired({ pairId: 'a' }), label: '电脑 2' },
      { ...paired({ pairId: 'b' }), label: '工作机' },
    ];
    expect(upsertDevice(list, paired({ pairId: 'c' }))[2].label).toBe('电脑 1');
  });

  it('同 pairId 重复配对：更新凭据但保留自定义名与位置', () => {
    const list = upsertDevice([], paired());
    const renamed = renameDevice(list, 'p1', '家里的 Mac');
    const next = upsertDevice(renamed, paired({ token: 'new-token' }));
    expect(next).toHaveLength(1);
    expect(next[0].token).toBe('new-token');
    expect(next[0].label).toBe('家里的 Mac');
  });
});

describe('removeDevice / renameDevice / pickActive', () => {
  it('remove 只删指定 pairId', () => {
    const list = upsertDevice(upsertDevice([], paired()), paired({ pairId: 'p2' }));
    const next = removeDevice(list, 'p1');
    expect(next.map((d) => d.pairId)).toEqual(['p2']);
  });

  it('rename 空白名忽略并原样返回', () => {
    const list = upsertDevice([], paired());
    expect(renameDevice(list, 'p1', '  ')[0].label).toBe('电脑 1');
  });

  it('pickActive：命中返回该台；失配回落第一台；空列表 null', () => {
    const list = upsertDevice(upsertDevice([], paired()), paired({ pairId: 'p2' }));
    expect(pickActive(list, 'p2')?.pairId).toBe('p2');
    expect(pickActive(list, 'gone')?.pairId).toBe('p1');
    expect(pickActive(list, null)?.pairId).toBe('p1');
    expect(pickActive([], 'p1')).toBeNull();
  });
});
