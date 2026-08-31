import { describe, expect, it } from 'vitest';
import { applyCatalog, applySnapshot, applySubscribe, initialSync } from './syncProjection';

describe('syncProjection', () => {
  it('订阅具体会话进入 syncing；回列表页（null）视为已同步', () => {
    expect(applySubscribe(initialSync, 's1').state).toBe('syncing');
    expect(applySubscribe(initialSync, null).state).toBe('synced');
  });

  it('刚 spawn 的全新会话：订阅即 synced，没有历史可陈旧', () => {
    expect(applySubscribe(initialSync, 's1', { fresh: true }).state).toBe('synced');
  });

  it('快照含订阅会话 → synced；不含则保持 syncing', () => {
    const syncing = applySubscribe(initialSync, 's1');
    expect(applySnapshot(syncing, 's1', ['s1', 's2']).state).toBe('synced');
    expect(applySnapshot(syncing, 's1', ['s2']).state).toBe('syncing');
  });

  it('未订阅会话时快照不改变状态', () => {
    expect(applySnapshot(initialSync, null, ['s1']).state).toBe('synced');
  });

  it('目录记录已知会话；首次出现不算幽灵', () => {
    const syncing = applySubscribe(initialSync, 's1');
    const { tracking, ghost } = applyCatalog(syncing, 's1', ['s1', 's2']);
    expect(ghost).toBe(false);
    expect(tracking.state).toBe('syncing');
  });

  it('曾在目录、现在消失 → 幽灵会话：结束 syncing 并报告 ghost', () => {
    const syncing = applySubscribe(initialSync, 's1');
    const seen = applyCatalog(syncing, 's1', ['s1']).tracking;
    const { tracking, ghost } = applyCatalog(seen, 's1', ['s2']);
    expect(ghost).toBe(true);
    expect(tracking.state).toBe('synced');
  });

  it('刚 spawn 的会话尚未进目录：不算幽灵，保持 syncing 等快照', () => {
    const syncing = applySubscribe(initialSync, 'fresh');
    const { tracking, ghost } = applyCatalog(syncing, 'fresh', ['s1', 's2']);
    expect(ghost).toBe(false);
    expect(tracking.state).toBe('syncing');
  });

  it('重新订阅（重连场景）会重置回 syncing', () => {
    const synced = applySnapshot(applySubscribe(initialSync, 's1'), 's1', ['s1']);
    expect(applySubscribe(synced, 's1').state).toBe('syncing');
  });
});
