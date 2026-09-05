import { describe, expect, it } from 'vitest';
import {
  catalogSyncFingerprint,
  changedMetaChannels,
  pairJsonFingerprint,
  shouldRelayPairSnapshot,
  slimCatalogForPhone,
  slimProjectsForPhone,
} from './metaSync';

describe('catalogSyncFingerprint', () => {
  it('忽略 updatedAt，流式刷新时间戳不重推目录', () => {
    const a = [{ id: 's', title: 't', status: 'running', updatedAt: 1 }];
    const b = [{ id: 's', title: 't', status: 'running', updatedAt: 2 }];
    expect(catalogSyncFingerprint(a, [])).toBe(catalogSyncFingerprint(b, []));
  });

  it('标题/状态/置顶顺序变化则指纹变', () => {
    const base = [{ id: 's', title: 't', status: 'idle' }];
    expect(catalogSyncFingerprint(base, [])).not.toBe(
      catalogSyncFingerprint([{ id: 's', title: 'u', status: 'idle' }], [])
    );
    expect(catalogSyncFingerprint(base, [])).not.toBe(
      catalogSyncFingerprint([{ id: 's', title: 't', status: 'running' }], [])
    );
    expect(catalogSyncFingerprint(base, [])).not.toBe(catalogSyncFingerprint(base, ['s']));
  });
});

describe('changedMetaChannels', () => {
  it('只返回指纹变化的通道', () => {
    const next = {
      catalog: 'c1',
      providers: 'p1',
      appearance: 'a1',
    };
    expect(changedMetaChannels({ catalog: 'c1', providers: 'old' }, next)).toEqual([
      'providers',
      'appearance',
    ]);
  });

  it('全新连接（无 last）全部有指纹的通道都发', () => {
    expect(changedMetaChannels(undefined, { catalog: 'c', hostInfo: 'h' })).toEqual([
      'catalog',
      'hostInfo',
    ]);
  });

  it('全相同则空', () => {
    const fps = { catalog: 'c', projects: 'p' };
    expect(changedMetaChannels(fps, fps)).toEqual([]);
  });
});

describe('pairJsonFingerprint', () => {
  it('同结构同指纹', () => {
    expect(pairJsonFingerprint({ a: 1 })).toBe(pairJsonFingerprint({ a: 1 }));
    expect(pairJsonFingerprint({ a: 1 })).not.toBe(pairJsonFingerprint({ a: 2 }));
  });
});

describe('slimCatalogForPhone', () => {
  const fat = {
    id: 's1',
    title: 't',
    projectId: 'p',
    projectName: 'app',
    status: 'idle',
    cwd: '/very/long/path/to/app',
    queued: [{ id: 'q', text: 'later' }],
    providerId: 'prov',
    modelId: 'm',
    reasoningEnabled: true,
    thinkingLevel: 'high' as const,
  };

  it('未订阅时剥掉 cwd/排队/模型，只留抽屉字段', () => {
    expect(slimCatalogForPhone([fat], null)).toEqual([
      { id: 's1', title: 't', projectId: 'p', status: 'idle' },
    ]);
  });

  it('当前订阅会话保留聊天所需字段', () => {
    expect(slimCatalogForPhone([fat, { ...fat, id: 's2' }], 's1')).toEqual([
      fat,
      { id: 's2', title: 't', projectId: 'p', status: 'idle' },
    ]);
  });
});

describe('slimProjectsForPhone', () => {
  it('不下发本机 path，手机 spawn 只传 projectId', () => {
    expect(
      slimProjectsForPhone([
        { id: 'p', name: 'app', path: '/Users/me/app', kind: 'local' as const },
      ])
    ).toEqual([{ id: 'p', name: 'app', kind: 'local' }]);
  });
});

describe('shouldRelayPairSnapshot', () => {
  it('未订阅不转发', () => {
    expect(shouldRelayPairSnapshot({ subscribedId: null, pendingSnapshot: true })).toBe(false);
  });

  it('已订阅但桌面自发快照不转发', () => {
    expect(shouldRelayPairSnapshot({ subscribedId: 's' })).toBe(false);
  });

  it('subscribe/snapshot 点名后转发', () => {
    expect(shouldRelayPairSnapshot({ subscribedId: 's', pendingSnapshot: true })).toBe(true);
  });

  it('history 分页挂起时转发（切片走同一条 snapshot）', () => {
    expect(shouldRelayPairSnapshot({ subscribedId: 's', pendingHistory: 10 })).toBe(true);
  });
});
