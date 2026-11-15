import { pairProjectListLabel, toPairProjectEntry } from '@enso/pair';
import { describe, expect, it } from 'vitest';
import {
  catalogSyncFingerprint,
  changedMetaChannels,
  channelsForMetaPush,
  forgetGuestSyncMeta,
  guestMetaChannels,
  mergeStableMeta,
  PAIR_META_CHANNELS,
  pairJsonFingerprint,
  planProviderEmit,
  providerChannelsToSend,
  providersSyncFingerprint,
  rememberStableMeta,
  shouldEmitProviders,
  shouldRelayPairSnapshot,
  slimCatalogForPhone,
  slimProjectsForPhone,
  withholdRendererMeta,
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

describe('withholdRendererMeta', () => {
  const all = ['catalog', 'projects', 'providers', 'appearance', 'pushConfig', 'hostInfo'] as const;

  it('renderer 尚未推过目录：扣下 catalog/projects/providers/appearance，只放 main 自有的通道', () => {
    // host 重启后 guest 已在房里，peer-joined 先于 renderer 首次 push；此时 catalog 是空初值，
    // 发出去会让 guest 把仍在订阅的会话误判为幽灵而跳离
    expect(withholdRendererMeta([...all], false)).toEqual(['pushConfig', 'hostInfo']);
  });

  it('renderer 已推过目录：原样放行', () => {
    expect(withholdRendererMeta([...all], true)).toEqual([...all]);
  });

  it('保持输入顺序，不补不重排', () => {
    expect(withholdRendererMeta(['hostInfo', 'catalog', 'pushConfig'], false)).toEqual([
      'hostInfo',
      'pushConfig',
    ]);
  });
});

describe('pairJsonFingerprint', () => {
  it('同结构同指纹', () => {
    expect(pairJsonFingerprint({ a: 1 })).toBe(pairJsonFingerprint({ a: 1 }));
    expect(pairJsonFingerprint({ a: 1 })).not.toBe(pairJsonFingerprint({ a: 2 }));
  });
});

describe('providersSyncFingerprint', () => {
  it('忽略名称/标签/顺序，只按 provider 与模型 id', () => {
    const a = [
      {
        id: 'g',
        name: 'Grok',
        models: [
          { id: 'b', label: 'B' },
          { id: 'a', label: 'A' },
        ],
      },
      { id: 'o', name: 'Other', models: [{ id: 'm' }] },
    ];
    const b = [
      { id: 'o', name: 'Other 2', models: [{ id: 'm', label: 'M' }] },
      { id: 'g', name: 'Grok 2', models: [{ id: 'a' }, { id: 'b' }] },
    ];
    expect(providersSyncFingerprint(a)).toBe(providersSyncFingerprint(b));
  });

  it('模型集合变化则指纹变', () => {
    const base = [{ id: 'g', models: [{ id: 'a' }] }];
    expect(providersSyncFingerprint(base)).not.toBe(
      providersSyncFingerprint([{ id: 'g', models: [{ id: 'a' }, { id: 'b' }] }])
    );
  });
});

describe('shouldEmitProviders', () => {
  it('相同指纹不重发', () => {
    expect(shouldEmitProviders('a', 0, 'a', 1000)).toBe(false);
  });

  it('窗口内即使指纹变也不重发', () => {
    expect(shouldEmitProviders('a', 1000, 'b', 1500, 1500)).toBe(false);
  });

  it('窗口外指纹变则发', () => {
    expect(shouldEmitProviders('a', 1000, 'b', 3000, 1500)).toBe(true);
  });

  it('从未发过则发', () => {
    expect(shouldEmitProviders(undefined, undefined, 'a', 1)).toBe(true);
  });
});

describe('planProviderEmit', () => {
  it('相同指纹视为已经同步', () => {
    expect(planProviderEmit('a', 0, 'a', 1000)).toEqual({ kind: 'unchanged' });
  });

  it('窗口内指纹变了要延后补发，不能当成已发出', () => {
    expect(planProviderEmit('empty', 1000, 'full', 1400, 1500)).toEqual({
      kind: 'defer',
      delayMs: 1100,
    });
  });

  it('窗口外指纹变了立即发', () => {
    expect(planProviderEmit('empty', 1000, 'full', 3000, 1500)).toEqual({ kind: 'send' });
  });

  it('从未发过则立即发', () => {
    expect(planProviderEmit(undefined, undefined, 'full', 1)).toEqual({ kind: 'send' });
  });

  it('延后的模型表不锁进 stable，避免空列表把后续真列表吞掉', () => {
    const plan = planProviderEmit('empty', 0, 'full', 400, 1500);
    const gated = providerChannelsToSend(['catalog', 'providers'], plan);
    expect(gated).toEqual({ channels: ['catalog'], deferMs: 1100 });
    expect(
      rememberStableMeta(undefined, gated.channels, { catalog: 'c', providers: 'full' })
    ).toBeUndefined();
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
    goal: { text: 'ship checkout', status: 'active' as const, autoTurns: 2 },
    slashCommands: [{ name: '/skill:foo', description: 'do foo' }],
    context: { used: 50, window: 200 },
    usageTotals: { inputTokens: 100, outputTokens: 20 },
  };

  it('未订阅时剥掉 cwd/排队/模型/目标/用量统计，只留抽屉字段', () => {
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

  // 别名全链路：桌面组帧 → 下发前裁剪 → 对端展示，真实 name 不被改写
  it('裁剪后保留别名，对端按别名展示且 name 仍是真实项目名', () => {
    const [entry] = slimProjectsForPhone([
      toPairProjectEntry({ id: 'p', name: 'enso-code', path: '/Users/me/app', alias: '线上' }),
    ]);
    expect(entry).toEqual({ id: 'p', name: 'enso-code', alias: '线上' });
    expect(pairProjectListLabel(entry)).toBe('线上');
  });

  it('别名新增与删除都会改变 projects 指纹，不被去重吞掉', () => {
    const base = toPairProjectEntry({ id: 'p', name: 'app', path: '/tmp/app' });
    const aliased = toPairProjectEntry({ id: 'p', name: 'app', path: '/tmp/app', alias: '线上' });
    const fingerprint = (project: object) =>
      pairJsonFingerprint({ projects: slimProjectsForPhone([project]), groups: [] });
    expect(fingerprint(aliased)).not.toBe(fingerprint(base));
  });
});

describe('channelsForMetaPush', () => {
  const next = {
    catalog: 'c',
    projects: 'p',
    providers: 'pr',
    appearance: 'a',
    pushConfig: 'push',
    hostInfo: 'host',
  } as const;

  it('指纹未变且非强制：不发', () => {
    expect(channelsForMetaPush({ ...next }, { ...next }, true)).toEqual([]);
  });

  it('guest 显式 snapshot（force）：即使指纹未变也整包重发', () => {
    expect(channelsForMetaPush({ ...next }, { ...next }, true, true)).toEqual([
      'catalog',
      'projects',
      'providers',
      'appearance',
      'pushConfig',
      'hostInfo',
    ]);
  });

  it('force 仍尊重 catalogReady：renderer 未就绪时不发空目录', () => {
    expect(channelsForMetaPush({ ...next }, { ...next }, false, true)).toEqual([
      'pushConfig',
      'hostInfo',
    ]);
  });
});

describe('guestMetaChannels', () => {
  it('完整模式只收 host-info 与推送配置，手机版照旧', () => {
    expect(guestMetaChannels([...PAIR_META_CHANNELS], true)).toEqual(['pushConfig', 'hostInfo']);
    expect(guestMetaChannels([...PAIR_META_CHANNELS], false)).toEqual([...PAIR_META_CHANNELS]);
  });
});

describe('forgetGuestSyncMeta', () => {
  const fps = {
    catalog: 'c',
    projects: 'p',
    providers: 'pr',
    appearance: 'a',
    pushConfig: 'push',
    hostInfo: 'host',
  } as const;

  it('进房作废全部指纹，模型表也重发', () => {
    expect(forgetGuestSyncMeta(fps)).toBeUndefined();
    expect(changedMetaChannels(undefined, fps)).toEqual([
      'catalog',
      'projects',
      'providers',
      'appearance',
      'pushConfig',
      'hostInfo',
    ]);
  });

  it('无历史指纹时仍是全新连接，不凭空造指纹', () => {
    expect(forgetGuestSyncMeta(undefined)).toBeUndefined();
  });

  it('进房后合并空指纹，模型表仍会重发', () => {
    const stable = forgetGuestSyncMeta(fps);
    const sent = forgetGuestSyncMeta({ catalog: 'c-old' });
    expect(changedMetaChannels(mergeStableMeta(stable, sent), fps)).toEqual([
      'catalog',
      'projects',
      'providers',
      'appearance',
      'pushConfig',
      'hostInfo',
    ]);
  });

  it('发出前只锁 providers 指纹，并发 flush 仍补项目和推送配置', () => {
    const stored = rememberStableMeta(undefined, PAIR_META_CHANNELS, fps);
    expect(changedMetaChannels(mergeStableMeta(stored, undefined), fps)).toEqual([
      'catalog',
      'projects',
      'appearance',
      'pushConfig',
      'hostInfo',
    ]);
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
