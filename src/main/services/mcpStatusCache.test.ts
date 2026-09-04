import { beforeEach, describe, expect, it } from 'vitest';
import { clearMcpStatuses, mcpStatusSnapshot, recordMcpStatus } from './mcpStatusCache';

beforeEach(() => clearMcpStatuses());

describe('mcpStatusCache', () => {
  it('按 serverId 归并，后到的状态覆盖前一条', () => {
    recordMcpStatus({
      type: 'mcp-status',
      serverId: 'srv-1',
      serverName: 'notion',
      state: 'connecting',
    });
    recordMcpStatus({
      type: 'mcp-status',
      serverId: 'srv-1',
      serverName: 'notion',
      state: 'ready',
      toolCount: 4,
    });
    expect(mcpStatusSnapshot()).toEqual([
      { type: 'mcp-status', serverId: 'srv-1', serverName: 'notion', state: 'ready', toolCount: 4 },
    ]);
  });

  it('缺 serverId 时按 serverName 归并，拿到 id 后迁移旧键', () => {
    recordMcpStatus({ type: 'mcp-status', serverName: 'notion', state: 'error', error: 'boom' });
    expect(mcpStatusSnapshot()).toHaveLength(1);
    recordMcpStatus({
      type: 'mcp-status',
      serverId: 'srv-1',
      serverName: 'notion',
      state: 'unauthorized',
    });
    expect(mcpStatusSnapshot()).toEqual([
      { type: 'mcp-status', serverId: 'srv-1', serverName: 'notion', state: 'unauthorized' },
    ]);
  });

  it('不同 server 各占一条', () => {
    recordMcpStatus({ type: 'mcp-status', serverId: 'a', serverName: 'A', state: 'ready' });
    recordMcpStatus({ type: 'mcp-status', serverId: 'b', serverName: 'B', state: 'idle' });
    expect(mcpStatusSnapshot()).toHaveLength(2);
  });

  it('worker 退出后清空，快照不留残值', () => {
    recordMcpStatus({ type: 'mcp-status', serverId: 'a', serverName: 'A', state: 'ready' });
    clearMcpStatuses();
    expect(mcpStatusSnapshot()).toEqual([]);
  });
});
