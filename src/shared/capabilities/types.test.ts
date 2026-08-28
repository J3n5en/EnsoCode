import { describe, expect, it } from 'vitest';
import {
  parseCapabilityAskDecisionAck,
  parseCapabilityAskRequest,
  parseCapabilityAskResponse,
  parseCapabilityExecutionEnvelope,
  parseCapabilityInvokeRequest,
  parseCapabilityReceipt,
  parseOauthFlowControlRequest,
  parseOauthFlowEvent,
  parseOauthFlowLocator,
  parseOauthFlowPromptResponse,
  parseReceiptLifecycleEvent,
  parseStartOauthResult,
  parseStartOauthWizardRequest,
} from './types';

const child = {
  sessionId: 'parent::cw-1',
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

const receipt = {
  receiptId: '44444444-4444-4444-8444-444444444444',
  operationId: 'op-1',
  child,
  turnId: 'turn-1',
  requestId: 'request-1',
  capabilityId: 'appearance.theme',
  risk: 'reversible',
  subject: { kind: 'setting', id: 'theme', label: 'Theme' },
  outcome: 'succeeded',
  summary: 'Theme changed',
  changes: [{ field: 'theme', previous: 'light', value: 'dark' }],
  occurredAt: 1,
  sequence: 0,
};

describe('child capability transport', () => {
  it('invoke 绑定 child generation/turn/request，旧 global invocation shape 拒绝', () => {
    const invoke = {
      child,
      turnId: 'turn-1',
      requestId: 'request-1',
      capabilityId: 'appearance.theme',
      params: { value: 'dark' },
    };
    expect(parseCapabilityInvokeRequest(invoke)).toEqual(invoke);
    expect(
      parseCapabilityInvokeRequest({
        invocationId: 'global-invocation',
        requestId: 'request-1',
        capabilityId: 'appearance.theme',
        params: {},
      })
    ).toBeNull();
    expect(
      parseCapabilityInvokeRequest({
        ...invoke,
        child: { ...child, generation: 'old-generation' },
      })
    ).toBeNull();
  });

  it('ASK/response 都绑定 child+turn，dangerous decision 无 allowSession', () => {
    const ask = {
      child,
      turnId: 'turn-1',
      requestId: 'request-1',
      capabilityId: 'providers.remove',
      summary: 'Remove provider',
    };
    expect(parseCapabilityAskRequest(ask)).toEqual(ask);
    expect(
      parseCapabilityAskResponse({
        child,
        turnId: 'turn-1',
        requestId: 'request-1',
        decision: 'allow',
      })
    ).not.toBeNull();
    expect(
      parseCapabilityAskResponse({
        child,
        turnId: 'turn-1',
        requestId: 'request-1',
        decision: 'allowSession',
      })
    ).toBeNull();
  });

  it('danger decision ACK 不把 cancel-requested 当 settled，失败 ACK 必须携 error', () => {
    expect(
      parseCapabilityAskDecisionAck({ ok: true, accepted: true, state: 'executing' })
    ).not.toBeNull();
    expect(
      parseCapabilityAskDecisionAck({ ok: true, accepted: false, state: 'cancel-requested' })
    ).not.toBeNull();
    expect(
      parseCapabilityAskDecisionAck({ ok: false, accepted: false, state: 'settled' })
    ).toBeNull();
    expect(
      parseCapabilityAskDecisionAck({
        ok: false,
        accepted: false,
        state: 'cancel-requested',
        error: 'Abort requested; awaiting real outcome',
      })
    ).not.toBeNull();
    expect(
      parseCapabilityAskDecisionAck({ ok: true, accepted: true, state: 'cancel-requested' })
    ).toBeNull();
  });

  it('OAuth ASK host 只含公开 provider 身份，额外 key/token 拒绝', () => {
    const base = {
      child,
      turnId: 'turn-1',
      requestId: 'request-1',
      capabilityId: 'providers.oauth.login',
      summary: 'Sign in',
    };
    const host = {
      kind: 'oauth-login',
      providerId: 'anthropic',
      providerLabel: 'Anthropic',
    };
    expect(parseCapabilityAskRequest({ ...base, host })).not.toBeNull();
    expect(parseCapabilityAskRequest({ ...base, host: { ...host, apiKey: 'secret' } })).toBeNull();
  });

  it('receipt/envelope 是 Main 权威唯一投影并严格绑定 child/turn/request', () => {
    expect(parseCapabilityReceipt(receipt)).toEqual(receipt);
    const envelope = { modelResult: { ok: true, data: { changed: true } }, receipt };
    expect(parseCapabilityExecutionEnvelope(envelope)).toEqual(envelope);
    expect(
      parseCapabilityReceipt({ ...receipt, child: { ...child, generation: 'old' } })
    ).toBeNull();
    expect(parseCapabilityReceipt({ ...receipt, apiKey: 'secret' })).toBeNull();
    expect(parseCapabilityExecutionEnvelope({ ...envelope, rawResult: 'secret' })).toBeNull();
  });

  it('receipt lifecycle 保持 danger lock 到真实 settled，并 exact 绑定 receipt', () => {
    const executing = {
      type: 'receipt-started',
      child,
      turnId: 'turn-1',
      requestId: 'request-1',
      receiptId: receipt.receiptId,
      receiptSeq: receipt.sequence,
      executionState: 'executing',
    };
    expect(parseReceiptLifecycleEvent(executing)).toEqual(executing);
    expect(
      parseReceiptLifecycleEvent({ ...executing, executionState: 'cancel-requested' })
    ).not.toBeNull();
    expect(
      parseReceiptLifecycleEvent({
        ...executing,
        type: 'receipt-settled',
        executionState: 'cancel-requested',
        receipt,
      })
    ).toBeNull();

    const settled = {
      ...executing,
      type: 'receipt-settled',
      executionState: 'settled',
      receipt,
    };
    expect(parseReceiptLifecycleEvent(settled)).toEqual(settled);
    expect(
      parseReceiptLifecycleEvent({
        ...settled,
        receiptSeq: receipt.sequence + 1,
      })
    ).toBeNull();
    expect(
      parseReceiptLifecycleEvent({
        ...settled,
        child: { ...child, generation: 'old' },
      })
    ).toBeNull();
    expect(
      parseReceiptLifecycleEvent({
        ...settled,
        receipt: { ...receipt, requestId: 'other-request' },
      })
    ).toBeNull();
  });
});

describe('OAuth exact locator/result', () => {
  const flowId = '55555555-5555-4555-8555-555555555555';
  const wizardLocator = { flowId, host: 'provider-wizard', ownerWebContentsId: 1 };
  const childLocator = {
    flowId,
    host: 'agent-child-tab',
    ownerWebContentsId: 2,
    child,
    turnId: 'turn-1',
    requestId: 'request-1',
  };

  it('wizard/agent-child-tab locator 严格分域并携 exact child generation/turn/request', () => {
    expect(parseOauthFlowLocator(wizardLocator)).toEqual(wizardLocator);
    expect(parseOauthFlowLocator(childLocator)).toEqual(childLocator);
    expect(
      parseOauthFlowLocator({
        ...childLocator,
        child: { ...child, generation: 'old' },
      })
    ).toBeNull();
    expect(parseOauthFlowLocator({ ...wizardLocator, child })).toBeNull();
    expect(parseOauthFlowLocator({ flowId })).toBeNull();
  });

  it('Wizard start 只接受 {providerId}，Renderer 不能提交 locator/owner/child', () => {
    expect(parseStartOauthWizardRequest({ providerId: 'anthropic' })).toEqual({
      providerId: 'anthropic',
    });
    expect(parseStartOauthWizardRequest({ providerId: '' })).toBeNull();
    expect(
      parseStartOauthWizardRequest({ providerId: 'anthropic', locator: wizardLocator })
    ).toBeNull();
  });

  it('prompt response 与 cancel/reopen 必须携完整 exact locator', () => {
    const prompt = { locator: childLocator, requestId: 'prompt-1', value: 'code' };
    expect(parseOauthFlowPromptResponse(prompt)).toEqual(prompt);
    expect(parseOauthFlowPromptResponse({ ...prompt, locator: { flowId } })).toBeNull();
    expect(parseOauthFlowPromptResponse({ ...prompt, sessionId: 'forged' })).toBeNull();
    expect(parseOauthFlowControlRequest({ locator: childLocator })).toEqual({
      locator: childLocator,
    });
    expect(parseOauthFlowControlRequest({ flowId })).toBeNull();
    expect(
      parseOauthFlowControlRequest({ locator: wizardLocator, ownerWebContentsId: 1 })
    ).toBeNull();
  });

  it('start ACK 与每个 event 都携 locator；completed 只由 done event 收敛', () => {
    expect(parseStartOauthResult({ status: 'started', locator: wizardLocator })).not.toBeNull();
    expect(parseStartOauthResult({ status: 'completed', locator: wizardLocator })).toBeNull();
    expect(parseStartOauthResult({ status: 'busy', activeHost: 'agent-child-tab' })).not.toBeNull();
    expect(
      parseStartOauthResult({ status: 'failed', code: 'network', message: 'Unavailable' })
    ).not.toBeNull();
    expect(
      parseOauthFlowEvent({
        locator: childLocator,
        event: { type: 'progress', message: 'Waiting' },
      })
    ).not.toBeNull();
    expect(
      parseOauthFlowEvent({
        locator: childLocator,
        event: {
          type: 'done',
          providerId: 'anthropic',
          account: { key: 'anthropic', providerId: 'anthropic' },
        },
      })
    ).not.toBeNull();
    expect(
      parseOauthFlowEvent({ flowId, event: { type: 'progress', message: 'Waiting' } })
    ).toBeNull();
  });
});
