import { describe, expect, it } from 'vitest';
import {
  absolutizeCssUrls,
  canSaveSnapshot,
  createSnapshotTracker,
  offlineSnapshotNote,
  packReads,
  snapshotReady,
  unpackReads,
} from './snapshot';

const base = {
  elapsed: 1000,
  liveChars: 0,
  snapChars: 5000,
  settingsLoaded: true,
  stableFor: 0,
  liveLoading: false,
  hostOnline: true,
};

describe('snapshotReady', () => {
  it('keeps the snapshot until the live renderer has its settings', () => {
    expect(
      snapshotReady({ ...base, settingsLoaded: false, liveChars: 9000, stableFor: 5000 })
    ).toBe(false);
  });

  it('switches once the live page shows most of the snapshot content', () => {
    expect(snapshotReady({ ...base, liveChars: 3000 })).toBe(false);
    expect(snapshotReady({ ...base, liveChars: 4200 })).toBe(true);
  });

  it('switches when content shrank but the live page has settled', () => {
    expect(snapshotReady({ ...base, liveChars: 1000, stableFor: 1000 })).toBe(false);
    expect(snapshotReady({ ...base, liveChars: 1000, stableFor: 2500 })).toBe(true);
  });

  it('keeps covering while the live timeline still shows its loading state', () => {
    expect(snapshotReady({ ...base, liveChars: 9000, stableFor: 9000, liveLoading: true })).toBe(
      false
    );
  });

  it('never blocks forever', () => {
    expect(snapshotReady({ ...base, settingsLoaded: false, elapsed: 20_000 })).toBe(true);
  });

  it('桌面不在线时一直保留快照，不受上限约束', () => {
    expect(snapshotReady({ ...base, hostOnline: false, elapsed: 600_000, liveChars: 9000 })).toBe(
      false
    );
  });

  it('上限只按桌面在线的时长累计；上线后照常揭开', () => {
    const step = createSnapshotTracker(0, 5000);
    const offline = { liveChars: 27, settingsLoaded: false, liveLoading: true, hostOnline: false };
    expect(step({ now: 1000, ...offline })).toBe(false);
    expect(step({ now: 60_000, ...offline })).toBe(false);
    // 上线了但 renderer 起不来：在线满 20s 才撤，离线的那一分钟不算
    const stuck = { liveChars: 27, settingsLoaded: false, liveLoading: true, hostOnline: true };
    expect(step({ now: 60_200, ...stuck })).toBe(false);
    expect(step({ now: 79_000, ...stuck })).toBe(false);
    expect(step({ now: 80_300, ...stuck })).toBe(true);
  });

  it('上线后内容追上就揭开，离线期间的稳定时长不算', () => {
    const step = createSnapshotTracker(0, 5000);
    const sample = { liveChars: 4500, settingsLoaded: true, liveLoading: false };
    expect(step({ now: 1000, ...sample, hostOnline: false })).toBe(false);
    expect(step({ now: 30_000, ...sample, hostOnline: false })).toBe(false);
    expect(step({ now: 30_200, ...sample, hostOnline: true })).toBe(true);
  });

  it('does not count time spent waiting for settings or history toward settled duration', () => {
    const step = createSnapshotTracker(0, 5000);
    const on = { hostOnline: true };
    // 隧道握手期间（0~3s）子页面一直停在初始空态，文字量未变
    expect(
      step({ now: 200, liveChars: 45, settingsLoaded: false, liveLoading: false, ...on })
    ).toBe(false);
    expect(
      step({ now: 3000, liveChars: 45, settingsLoaded: false, liveLoading: false, ...on })
    ).toBe(false);
    // settings 刚到达父窗口的瞬间，不能把前面等网络的 2.8s 算成已稳定而提前揭开快照
    expect(
      step({ now: 3200, liveChars: 45, settingsLoaded: true, liveLoading: false, ...on })
    ).toBe(false);
    // 历史加载期间也不累计稳定时长
    expect(step({ now: 6000, liveChars: 45, settingsLoaded: true, liveLoading: true, ...on })).toBe(
      false
    );
    expect(
      step({ now: 6200, liveChars: 45, settingsLoaded: true, liveLoading: false, ...on })
    ).toBe(false);
    // 加载结束后真正稳定满 2.5s 才揭开
    expect(
      step({ now: 8700, liveChars: 45, settingsLoaded: true, liveLoading: false, ...on })
    ).toBe(true);
  });

  it('启动请求都回来、没有缺帧满 QUIET 就揭开，不等文字量稳定 2.5s', () => {
    const step = createSnapshotTracker(0, 5000);
    const ready = { settingsLoaded: true, liveLoading: false, hostOnline: true };
    const early = { ...ready, settingsLoaded: false, requestsIdle: true };
    // 设置未到时请求空闲不算
    expect(step({ now: 200, liveChars: 45, ...early })).toBe(false);
    // 有请求在途：照旧等
    expect(step({ now: 1000, liveChars: 1000, ...ready, requestsIdle: false })).toBe(false);
    expect(step({ now: 1200, liveChars: 1100, ...ready, requestsIdle: true })).toBe(false);
    // 会话还在流式输出、文字一直在变，满 250ms 也照样揭开
    expect(step({ now: 1350, liveChars: 1300, ...ready, requestsIdle: true })).toBe(false);
    expect(step({ now: 1450, liveChars: 1400, ...ready, requestsIdle: true })).toBe(true);
  });

  it('空闲中途又有请求发出：空闲时长重新计', () => {
    const step = createSnapshotTracker(0, 5000);
    const ready = { settingsLoaded: true, liveLoading: false, hostOnline: true };
    expect(step({ now: 1000, liveChars: 1000, ...ready, requestsIdle: true })).toBe(false);
    expect(step({ now: 1400, liveChars: 1100, ...ready, requestsIdle: false })).toBe(false);
    expect(step({ now: 1600, liveChars: 1200, ...ready, requestsIdle: true })).toBe(false);
    expect(step({ now: 1849, liveChars: 1300, ...ready, requestsIdle: true })).toBe(false);
    expect(step({ now: 1850, liveChars: 1400, ...ready, requestsIdle: true })).toBe(true);
  });

  it('实时正文达到阈值后稳定 1.2s 即揭开；不足阈值仍等 2.5s', () => {
    const enough = snapshotReady({
      snapChars: 5000,
      liveChars: 200,
      stableFor: 1199,
      elapsed: 2000,
      settingsLoaded: true,
      liveLoading: false,
      hostOnline: true,
    });
    expect(enough).toBe(false);
    expect(
      snapshotReady({
        snapChars: 5000,
        liveChars: 200,
        stableFor: 1200,
        elapsed: 2000,
        settingsLoaded: true,
        liveLoading: false,
        hostOnline: true,
      })
    ).toBe(true);
    expect(
      snapshotReady({
        snapChars: 5000,
        liveChars: 199,
        stableFor: 1200,
        elapsed: 2000,
        settingsLoaded: true,
        liveLoading: false,
        hostOnline: true,
      })
    ).toBe(false);
    expect(
      snapshotReady({
        snapChars: 5000,
        liveChars: 199,
        stableFor: 2500,
        elapsed: 2000,
        settingsLoaded: true,
        liveLoading: false,
        hostOnline: true,
      })
    ).toBe(true);
  });

  it('乐观水合已就绪且正文达标时不必苦等网络完成即可提前揭开快照；正文不足仍继续盖着', () => {
    expect(
      snapshotReady({
        ...base,
        settingsLoaded: false,
        optimisticHydrated: true,
        liveChars: 4200,
        liveLoading: false,
        hostOnline: true,
      })
    ).toBe(true);
    // 离线时仍保持快照，给出离线时间提示，不提前暴露未连网的空操作态
    expect(
      snapshotReady({
        ...base,
        settingsLoaded: false,
        optimisticHydrated: true,
        liveChars: 4200,
        liveLoading: false,
        hostOnline: false,
      })
    ).toBe(false);
    // 实时时间线仍在加载或文字不足：即使乐观水合完成也继续盖着
    expect(
      snapshotReady({
        ...base,
        settingsLoaded: false,
        optimisticHydrated: true,
        liveChars: 4200,
        liveLoading: true,
        hostOnline: true,
      })
    ).toBe(false);
    expect(
      snapshotReady({
        ...base,
        settingsLoaded: false,
        optimisticHydrated: true,
        liveChars: 150,
        liveLoading: false,
        hostOnline: true,
      })
    ).toBe(false);
  });

  it('tracker 在 optimisticHydrated 提前放行时，文字达标立即揭开', () => {
    const step = createSnapshotTracker(0, 5000);
    expect(
      step({
        now: 100,
        liveChars: 50,
        settingsLoaded: false,
        optimisticHydrated: true,
        liveLoading: false,
        hostOnline: true,
      })
    ).toBe(false);
    expect(
      step({
        now: 200,
        liveChars: 4200,
        settingsLoaded: false,
        optimisticHydrated: true,
        liveLoading: false,
        hostOnline: true,
      })
    ).toBe(true);
  });
});

describe('offlineSnapshotNote', () => {
  const now = new Date(2026, 10, 21, 18, 30);
  it('写明快照是什么时候的', () => {
    expect(offlineSnapshotNote(new Date(2026, 10, 21, 9, 5).getTime(), now)).toBe(
      '桌面不在线 · 显示 09:05 的内容'
    );
    expect(offlineSnapshotNote(new Date(2026, 10, 19, 23, 40).getTime(), now)).toBe(
      '桌面不在线 · 显示 11月19日 23:40 的内容'
    );
  });
  it('旧快照没有时间或时间不合理时只说不在线', () => {
    expect(offlineSnapshotNote(null, now)).toBe('桌面不在线');
    expect(offlineSnapshotNote(Number.NaN, now)).toBe('桌面不在线');
    expect(offlineSnapshotNote(now.getTime() + 3_600_000, now)).toBe('桌面不在线');
  });
  it('手机没网时换成对应说法', () => {
    expect(offlineSnapshotNote(new Date(2026, 10, 21, 9, 5).getTime(), now, '网络未连接')).toBe(
      '网络未连接 · 显示 09:05 的内容'
    );
  });
});

describe('canSaveSnapshot', () => {
  it('refuses to overwrite a good snapshot while hydrating/loading or when content is too short', () => {
    expect(canSaveSnapshot(500, true)).toBe(false);
    expect(canSaveSnapshot(120, false)).toBe(false);
    expect(canSaveSnapshot(500, false)).toBe(true);
  });
});

describe('absolutizeCssUrls', () => {
  it('resolves relative url() against the stylesheet, leaving absolute/data urls alone', () => {
    const css =
      "@font-face{src:url(./KaTeX.woff2) format('woff2'),url(\"../x/y.ttf\")}a{background:url('data:image/png;base64,AA')}b{background:url(/abs.png)}c{background:url(#m)}";
    expect(absolutizeCssUrls(css, 'https://h/desk/r/p/v/assets/index.css')).toBe(
      '@font-face{src:url("https://h/desk/r/p/v/assets/KaTeX.woff2") format(\'woff2\'),url("https://h/desk/r/p/v/x/y.ttf")}a{background:url(\'data:image/png;base64,AA\')}b{background:url(/abs.png)}c{background:url(#m)}'
    );
  });
});

describe('packReads / unpackReads', () => {
  const entry = (n: number) => ({ h: `h${n}`, json: 'x'.repeat(n) });

  it('round-trips and keeps the most recent entries within the budget', () => {
    const reads = new Map([
      ['a', entry(40)],
      ['b', entry(30)],
      ['c', entry(20)],
    ]);
    const restored = unpackReads(packReads(reads, 60));
    expect([...restored.keys()]).toEqual(['b', 'c']);
    expect(restored.get('c')).toEqual(entry(20));
  });

  it('放不下的大条目跳过，继续保留更早的小条目（会话列表不该被几个大资源挤掉）', () => {
    const reads = new Map([
      ['conversations', entry(30)],
      ['theme', entry(80)],
      ['settings', entry(20)],
    ]);
    const restored = unpackReads(packReads(reads, 80));
    expect([...restored.keys()]).toEqual(['conversations', 'settings']);
  });

  it('ignores malformed input', () => {
    expect(unpackReads('nope').size).toBe(0);
    expect(
      unpackReads(
        JSON.stringify([
          ['k', { h: 1 }],
          ['ok', { h: 'h', json: '1' }],
        ])
      ).size
    ).toBe(1);
  });
});
