import type { ChildSessionIdentity } from '@shared/builtinAgents';
import type {
  CapabilityExecutionEnvelope,
  CapabilityInvokeRequest,
  CapabilityResult,
} from '@shared/capabilities/types';
import { describe, expect, it, vi } from 'vitest';
import { EnsoAppInvoker } from './ensoApp';

const child: ChildSessionIdentity = {
  sessionId: 'parent::enso',
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
const success: CapabilityResult = { ok: true, data: { language: 'zh-CN' } };

function envelope(result: CapabilityResult = success): CapabilityExecutionEnvelope {
  return {
    modelResult: result,
    receipt: {
      receiptId: '44444444-4444-4444-8444-444444444444',
      operationId: 'op-1',
      child,
      turnId: 'turn-1',
      requestId: 'request-1',
      capabilityId: 'general.language',
      risk: 'reversible',
      subject: { kind: 'setting', id: 'language', label: 'language' },
      outcome: result.ok ? 'succeeded' : 'failed',
      summary: result.ok ? 'changed' : result.error,
      occurredAt: 1,
      sequence: 0,
    },
  };
}

describe('EnsoAppInvoker', () => {
  it('绑定locked child与当前turn，Main envelope匹配后只把modelResult交给模型', async () => {
    const emitted: CapabilityInvokeRequest[] = [];
    const invoker = new EnsoAppInvoker(
      child,
      () => 'turn-1',
      (request) => emitted.push(request)
    );
    const params = { value: 'zh-CN', gatewayOwnsValidation: true };

    const pending = invoker.invoke('general.language', params);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      child,
      turnId: 'turn-1',
      capabilityId: 'general.language',
      params,
    });
    expect(emitted[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/i);

    expect(invoker.resolve('turn-1', emitted[0]!.requestId, envelope())).toEqual({ ok: true });
    await expect(pending).resolves.toEqual(success);
    expect(invoker.pendingCount).toBe(0);
  });

  it('错turn拒绝并清理，迟到正确结果不能复活', async () => {
    const emitted: CapabilityInvokeRequest[] = [];
    const invoker = new EnsoAppInvoker(
      child,
      () => 'turn-current',
      (request) => emitted.push(request)
    );
    const pending = invoker.invoke('providers.list', {});
    const requestId = emitted[0]!.requestId;

    expect(invoker.resolve('turn-stale', requestId, envelope())).toEqual({
      ok: false,
      error: 'turn mismatch',
    });
    await expect(pending).rejects.toThrow('Enso capability result turn mismatch');
    expect(invoker.resolve('turn-current', requestId, envelope())).toEqual({
      ok: false,
      error: 'unknown request',
    });
  });

  it('abort 与 worker shutdown 都拒绝并清空pending', async () => {
    const emit = vi.fn<(request: CapabilityInvokeRequest) => void>();
    const invoker = new EnsoAppInvoker(child, () => 'turn-1', emit);
    const abortController = new AbortController();
    const aborted = invoker.invoke('providers.list', {}, abortController.signal);
    abortController.abort();

    await expect(aborted).rejects.toThrow('Enso capability invocation aborted');
    const first = invoker.invoke('providers.list', {});
    const second = invoker.invoke('tools.list', {});
    invoker.cancelAll('Enso worker shutdown');
    await expect(first).rejects.toThrow('Enso worker shutdown');
    await expect(second).rejects.toThrow('Enso worker shutdown');
    expect(invoker.pendingCount).toBe(0);
  });

  it('缺turn、未知或known-unavailable capability不发请求', async () => {
    const emit = vi.fn<(request: CapabilityInvokeRequest) => void>();
    const withoutTurn = new EnsoAppInvoker(child, () => undefined, emit);

    await expect(withoutTurn.invoke('providers.list', {})).rejects.toThrow(
      'enso_app requires an active child turn'
    );
    await expect(withoutTurn.invoke('raw.ipc.invoke', {})).rejects.toThrow(
      'unknown capability: raw.ipc.invoke'
    );
    await expect(withoutTurn.invoke('coding-tools.command', {})).rejects.toThrow(
      'capability unavailable:'
    );
    expect(emit).not.toHaveBeenCalled();
  });
});
