import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchMainEvent } from '../shared/types/agent';
import { IPC_CHANNELS } from '../shared/types/ipc';
import './index';

const mocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.exposeInMainWorld },
  ipcRenderer: {
    invoke: mocks.invoke,
    on: mocks.on,
    removeListener: mocks.removeListener,
  },
  webUtils: { getPathForFile: vi.fn() },
}));

type DispatchApi = {
  agentDispatch: {
    onEvent(callback: (event: DispatchMainEvent) => void): () => void;
  };
};

const electronAPI = mocks.exposeInMainWorld.mock.calls[0]?.[1] as DispatchApi;

const event = {
  dispatchId: '66666666-6666-4666-8666-666666666666',
  child: {
    sessionId: 'conversation-1::cw-33333333',
    generation: '22222222-2222-4222-8222-222222222222',
    parent: {
      sessionId: 'conversation-1',
      generation: '11111111-1111-4111-8111-111111111111',
    },
    instanceId: '33333333-3333-4333-8333-333333333333',
    instanceName: 'Enso 3333',
    typeKey: 'agent:enso',
    profileId: 'enso-locked-v1',
  },
  mainSeq: 1,
  phase: 'running',
} as const;

describe('preload agentDispatch.onEvent', () => {
  beforeEach(() => {
    mocks.on.mockClear();
    mocks.removeListener.mockClear();
  });

  it('独立订阅 Main dispatch event，回调前拒绝非 strict payload', () => {
    const callback = vi.fn();
    const unsubscribe = electronAPI.agentDispatch.onEvent(callback);
    const registration = mocks.on.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.AGENT_DISPATCH_EVENT
    );
    expect(registration).toBeDefined();
    const listener = registration?.[1] as (ipcEvent: unknown, payload: unknown) => void;

    listener({}, event);
    expect(callback).toHaveBeenCalledWith(event);

    listener({}, { ...event, mainSeq: 2, workerSeq: 99 });
    listener({}, { ...event, child: { ...event.child, generation: 'stale' } });
    expect(callback).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(mocks.removeListener).toHaveBeenCalledWith(IPC_CHANNELS.AGENT_DISPATCH_EVENT, listener);
  });
});
