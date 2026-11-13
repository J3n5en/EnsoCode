import { describe, expect, it } from 'vitest';
import { snapshotBuiltinOccupancyTools } from './builtinOccupancy';

describe('snapshotBuiltinOccupancyTools', () => {
  // 回归：createTaskTools 构造时就读 manager.limits，桩对象缺这个字段会抛 TypeError，
  // Main 侧内置工具占用估算（assets IPC）因此每次都失败
  it('后台任务工具的描述能按默认限额生成，整份快照不抛错', () => {
    const snapshot = snapshotBuiltinOccupancyTools();
    expect(snapshot.background_tasks.length).toBeGreaterThan(0);
  });
});
