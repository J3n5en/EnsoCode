import type { PendingMemoryWriteDto } from '@shared/memory/dto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const item = (id: string): PendingMemoryWriteDto => ({
  id,
  kind: 'capture',
  spaceId: 'global',
  spaceLabel: 'Global',
  originLabel: '成员：Alice',
  title: null,
  content: id,
  botId: 'b1',
  chatId: null,
  redacted: false,
  createdAt: '2026-10-05T00:00:00.000Z',
});

const listeners: (() => void)[] = [];
const memory = {
  pendingWrites: vi.fn(async () => [item('p1'), item('p2')]),
  reviewPendingWrite: vi.fn(async () => ({ ok: true })),
  onChanged: vi.fn((listener: () => void) => {
    listeners.push(listener);
    return () => listeners.splice(listeners.indexOf(listener), 1);
  }),
};
vi.stubGlobal('window', { electronAPI: { memory } });

const { bindPendingMemoryWrites, usePendingMemoryWritesStore } = await import('./memoryReview');

describe('pending memory writes store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePendingMemoryWritesStore.setState({ items: [] });
  });

  it('bind 拉一次并随 memory 变更刷新；引用计数归零才退订', async () => {
    const offA = bindPendingMemoryWrites();
    const offB = bindPendingMemoryWrites();
    await vi.waitFor(() => expect(usePendingMemoryWritesStore.getState().items).toHaveLength(2));
    expect(memory.onChanged).toHaveBeenCalledTimes(1);
    memory.pendingWrites.mockResolvedValueOnce([item('p3')]);
    for (const listener of [...listeners]) listener();
    await vi.waitFor(() =>
      expect(usePendingMemoryWritesStore.getState().items.map((x) => x.id)).toEqual(['p3'])
    );
    offA();
    expect(listeners).toHaveLength(1);
    offB();
    expect(listeners).toHaveLength(0);
  });

  it('审批后本地先移除该项，再以权威列表为准', async () => {
    usePendingMemoryWritesStore.setState({ items: [item('p1'), item('p2')] });
    memory.pendingWrites.mockResolvedValueOnce([item('p2')]);
    const result = await usePendingMemoryWritesStore.getState().review('p1', 'approve');
    expect(result).toEqual({ ok: true });
    expect(memory.reviewPendingWrite).toHaveBeenCalledWith('p1', 'approve');
    expect(usePendingMemoryWritesStore.getState().items.map((x) => x.id)).toEqual(['p2']);
  });
});
