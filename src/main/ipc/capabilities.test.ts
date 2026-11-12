import type { ChildSessionIdentity } from '@shared/builtinAgents';
import { parseCapabilityExecutionEnvelope } from '@shared/capabilities/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  sendResult: vi.fn(),
}));

vi.mock('../services/capabilityGateway', () => ({
  CapabilityGateway: class {
    invoke = mocks.invoke;
  },
}));
vi.mock('../services/agentHost', () => ({
  appendSessionCustomEntry: vi.fn(),
  sendCapabilityResultToSession: mocks.sendResult,
}));

import { handleCapabilityInvoke } from './capabilities';

const child: ChildSessionIdentity = {
  sessionId: 'parent::enso-1',
  generation: '22222222-2222-4222-8222-222222222222',
  parent: {
    sessionId: 'parent',
    generation: '11111111-1111-4111-8111-111111111111',
  },
  instanceId: '33333333-3333-4333-8333-333333333333',
  instanceName: 'Enso 3333',
  typeKey: 'agent:enso',
  profileId: 'enso-locked-v1',
};

describe('handleCapabilityInvoke', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.sendResult.mockReset();
  });

  // 背景：网关 invoke 有几处 await 不在 try 内（如读 OAuth 列表），一旦 reject，child 会一直等结果
  it('网关 invoke 意外 reject：仍给 child 回一个 worker 收得下的失败结果', async () => {
    mocks.invoke.mockRejectedValue(new Error('keychain locked'));

    handleCapabilityInvoke({
      type: 'capability-invoke',
      child,
      seq: 1,
      turnId: 'turn-1',
      requestId: 'req-1',
      capabilityId: 'projects.recent',
      params: {},
    });

    await vi.waitFor(() => expect(mocks.sendResult).toHaveBeenCalledTimes(1));
    const [sentChild, turnId, requestId, envelope] = mocks.sendResult.mock.calls[0];
    expect([sentChild, turnId, requestId]).toEqual([child, 'turn-1', 'req-1']);
    expect(parseCapabilityExecutionEnvelope(envelope)?.modelResult).toMatchObject({
      ok: false,
      code: 'failed',
    });
  });
});
