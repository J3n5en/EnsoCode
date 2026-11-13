import { describe, expect, it } from 'vitest';
import {
  parseOauthFlowControlRequest,
  parseOauthFlowEvent,
  parseOauthFlowLocator,
  parseOauthFlowPromptResponse,
  parseStartOauthResult,
  parseStartOauthWizardRequest,
} from './oauthFlow';

const child = {
  sessionId: 'parent::cw-1',
  generation: '22222222-2222-4222-8222-222222222222',
  parent: {
    sessionId: 'parent',
    generation: '11111111-1111-4111-8111-111111111111',
  },
  instanceId: '33333333-3333-4333-8333-333333333333',
  instanceName: 'scout 3333',
  typeKey: 'builtin:scout',
};

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

  // 真实场景：Qoder 的 PAT 提示留空即走浏览器登录；传输层先把空串拦掉，Main 根本收不到
  it('prompt response 的 value 可以是空串，放行与否交给 Main 按登记的提示裁决', () => {
    const prompt = { locator: wizardLocator, requestId: 'prompt-1', value: '' };
    expect(parseOauthFlowPromptResponse(prompt)).toEqual(prompt);
  });

  // 安全边界：调用方不能替提示声明 allowEmpty，value 仍按 unknown 收窄为字符串
  it('prompt response 不接受夹带的 allowEmpty，value 必须是字符串', () => {
    const prompt = { locator: wizardLocator, requestId: 'prompt-1', value: '' };
    expect(parseOauthFlowPromptResponse({ ...prompt, allowEmpty: true })).toBeNull();
    for (const value of [undefined, null, 0, false, ['code'], { code: 'x' }]) {
      expect(parseOauthFlowPromptResponse({ ...prompt, value })).toBeNull();
    }
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
