import { IPC_CHANNELS } from '@shared/types/ipc';
import { describe, expect, it } from 'vitest';
import { RemoteWriteBases, RemoteWriteClient, writeSeedOf } from './remoteDelta';
import { compactRemoteWireResult, expandRemoteWireResult } from './remoteWireCompact';

function samplePersistConversation(
  id: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    projectId: 'p1',
    title: `Chat ${id}`,
    createdAt: 1000,
    lastActiveAt: 2000,
    sessionFile: `/tmp/${id}.jsonl`,
    messages: [],
    commands: [],
    customEntries: [],
    dispatchMainEvents: {},
    lastSeq: 0,
    spawning: false,
    started: false,
    status: 'idle',
    toolOutputs: {},
    toolStartedAt: {},
    toolDeadlineAt: {},
    toolEnded: {},
    toolTodos: {},
    pendingApprovals: [],
    pendingAsks: [],
    backgroundTasks: [],
    subagents: [],
    ...overrides,
  };
}

describe('remoteWireCompact', () => {
  it('CONVERSATIONS_READ 剥离常量运行态空默认值以压缩线体积，并无损展开', () => {
    const conversations: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 40; i++) {
      conversations[`c${i}`] = samplePersistConversation(`c${i}`);
    }
    conversations.c5 = samplePersistConversation('c5', {
      status: 'interrupted',
      lastSeq: 9,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    const raw = {
      seq: 12,
      value: {
        version: 4,
        state: {
          activeId: 'c5',
          order: Object.keys(conversations),
          conversations,
        },
      },
    };

    const compacted = compactRemoteWireResult(IPC_CHANNELS.CONVERSATIONS_READ, raw);
    const rawSize = JSON.stringify(raw).length;
    const compactSize = JSON.stringify(compacted).length;
    expect(compactSize).toBeLessThan(rawSize * 0.55);

    const expanded = expandRemoteWireResult(
      IPC_CHANNELS.CONVERSATIONS_READ,
      JSON.parse(JSON.stringify(compacted))
    ) as typeof raw;
    expect(expanded).toEqual(raw);

    // 展开后每条记录的空数组/空对象不能共享同一个引用
    const expandedConvs = expanded.value.state.conversations;
    expect(expandedConvs.c0?.messages).not.toBe(expandedConvs.c1?.messages);
    expect(expandedConvs.c0?.toolOutputs).not.toBe(expandedConvs.c1?.toolOutputs);
  });

  it('无标记、坏形状或其他通道原样透传', () => {
    const untouched = { seq: 1, value: { state: { conversations: { a: { id: 'a' } } } } };
    expect(expandRemoteWireResult(IPC_CHANNELS.CONVERSATIONS_READ, untouched)).toEqual(untouched);
    expect(compactRemoteWireResult(IPC_CHANNELS.CONVERSATIONS_READ, null)).toBeNull();
    expect(compactRemoteWireResult('other:channel', untouched)).toBe(untouched);
  });

  it('CONVERSATIONS_READ 压缩并展开后，宿主与 shim 的写入增量基线完全一致（首次写回走增量）', async () => {
    const raw = {
      seq: 3,
      value: {
        version: 4,
        state: {
          activeId: 'c1',
          order: ['c1', 'c2'],
          conversations: {
            c1: samplePersistConversation('c1'),
            c2: samplePersistConversation('c2'),
          },
        },
      },
    };
    const compactedJson = JSON.stringify(
      compactRemoteWireResult(IPC_CHANNELS.CONVERSATIONS_READ, raw)
    );

    const hostBases = new RemoteWriteBases();
    hostBases.seedLazy(
      'enso-conversations',
      () =>
        writeSeedOf(
          IPC_CHANNELS.CONVERSATIONS_READ,
          expandRemoteWireResult(IPC_CHANNELS.CONVERSATIONS_READ, JSON.parse(compactedJson))
        )?.value
    );

    const clientWrites = new RemoteWriteClient();
    clientWrites.seedLazy(
      'enso-conversations',
      () =>
        writeSeedOf(
          IPC_CHANNELS.CONVERSATIONS_READ,
          expandRemoteWireResult(IPC_CHANNELS.CONVERSATIONS_READ, JSON.parse(compactedJson))
        )?.value
    );

    const updated = structuredClone(raw.value);
    (updated.state.conversations.c1 as Record<string, unknown>).title = 'Renamed';

    let wireArg: unknown;
    await clientWrites.write('enso-conversations', updated, async (arg) => {
      wireArg = arg;
      const resolved = hostBases.resolve('enso-conversations', arg);
      resolved.commit();
      expect(resolved.value).toEqual(updated);
      return true;
    });
    expect(wireArg).toMatchObject({
      __ensoWrite: { ops: expect.any(Array) },
    });
  });

  it('SOURCE_AUTHORITY_READ 过滤已归档/移除项目与子会话并压缩展开根会话默认字段', () => {
    const raw = {
      projects: [
        {
          projectId: 'p1',
          canonicalPath: '/repo/a',
          state: 'active',
          kind: 'local',
          version: 2,
        },
        {
          projectId: 'p-removed',
          canonicalPath: '/repo/old',
          state: 'removed',
          kind: 'local',
          version: 1,
        },
      ],
      conversations: [
        {
          conversationId: 'r1',
          projectId: 'p1',
          kind: 'root',
          lifecycle: 'ready',
          version: 3,
        },
        {
          conversationId: 'child-1',
          projectId: 'p1',
          kind: 'child',
          parentConversationId: 'r1',
          lifecycle: 'ready',
          version: 1,
        },
      ],
    };

    const compacted = compactRemoteWireResult(IPC_CHANNELS.SOURCE_AUTHORITY_READ, raw);
    const expanded = expandRemoteWireResult(
      IPC_CHANNELS.SOURCE_AUTHORITY_READ,
      JSON.parse(JSON.stringify(compacted))
    ) as typeof raw;

    expect(expanded.projects).toEqual([raw.projects[0]]);
    expect(expanded.conversations).toEqual([raw.conversations[0]]);
  });
});
