import { describe, expect, it } from 'vitest';
import { parseAgentCommand, parseAgentSessionCustomEntry, parseAgentWorkerEvent } from './agent';

const identity = { sessionId: 'fixture', generation: '11111111-1111-4111-8111-111111111111' };
const model = {
  api: 'openai-responses',
  apiKey: '',
  baseUrl: '',
  modelId: 'gpt-fixture',
  settingsProviderId: 'pool',
  oauthAccountKey: 'openai-codex',
  oauthAccountPool: { accountKeys: ['openai-codex', 'openai-codex#2'] },
};

describe('账号池 typed worker 协议', () => {
  it('结果与failure接收opaque UUID，坏票、错误结果携票及凭据均拒绝', () => {
    const selectionReceipt = '11111111-1111-4111-8111-111111111111';
    const success = {
      type: 'oauth-pool-result',
      requestId: 'r',
      accountKey: 'openai-codex',
      selectionReceipt,
    };
    const event = {
      type: 'oauth-pool-select',
      requestId: 'r',
      settingsProviderId: 'pool',
      modelId: 'm',
      failed: { accountKey: 'openai-codex', reason: 'login-invalid', selectionReceipt },
    };
    expect(parseAgentCommand(success)).toEqual(success);
    expect(parseAgentWorkerEvent(event)).toEqual(event);
    for (const bad of [null, '', 42, {}, 'not-a-uuid', 'a'.repeat(36)]) {
      expect(parseAgentCommand({ ...success, selectionReceipt: bad })).toBeNull();
      expect(
        parseAgentWorkerEvent({ ...event, failed: { ...event.failed, selectionReceipt: bad } })
      ).toBeNull();
    }
    expect(
      parseAgentCommand({
        type: 'oauth-pool-result',
        requestId: 'r',
        error: 'failed',
        selectionReceipt,
      })
    ).toBeNull();
    for (const field of ['auth', 'identity', 'credentialGeneration', 'digest']) {
      expect(parseAgentCommand({ ...success, [field]: 'secret' })).toBeNull();
      expect(
        parseAgentWorkerEvent({ ...event, failed: { ...event.failed, [field]: 'secret' } })
      ).toBeNull();
    }
  });
  it('实际账号通知携带成对路由身份，旧历史兼容但脏 scope 被拒绝', () => {
    const notice = {
      kind: 'oauth-account-selected',
      accountKey: 'openai-codex#2',
      settingsProviderId: 'pool',
      modelId: 'gpt-fixture',
      at: 1,
    };
    expect(parseAgentSessionCustomEntry(notice)).toEqual(notice);
    for (const patch of [
      { settingsProviderId: '' },
      { modelId: '' },
      { settingsProviderId: undefined },
      { modelId: undefined },
      { settingsProviderId: 1 },
    ]) {
      expect(parseAgentSessionCustomEntry({ ...notice, ...patch })).toBeNull();
    }
  });
  it('合法池配置通过，脏池不得被丢弃并固定使用锚点', () => {
    const command = { type: 'spawn-parent', identity, cwd: '/fixture', model };
    expect(parseAgentCommand(command)).toEqual(command);
    for (const invalid of [
      null,
      {},
      { accountKeys: [] },
      { accountKeys: ['anthropic'] },
      { accountKeys: ['openai-codex', 'openai-codex'] },
    ]) {
      expect(
        parseAgentCommand({ ...command, model: { ...model, oauthAccountPool: invalid } })
      ).toBeNull();
    }
    expect(parseAgentCommand({ ...command, model: { ...model, apiKey: 'key' } })).toBeNull();
    expect(
      parseAgentCommand({ ...command, model: { ...model, oauthAccountKey: 'anthropic' } })
    ).toBeNull();
  });
  it('选号事件只接受闭集失效原因和有限排除成员，凭据不得混入', () => {
    const event = {
      type: 'oauth-pool-select',
      requestId: 'request',
      settingsProviderId: 'pool',
      modelId: 'gpt-fixture',
      failed: { accountKey: 'openai-codex', reason: 'quota-exhausted', resetAt: 12345 },
      excludedAccountKeys: ['openai-codex'],
    };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
    for (const patch of [
      { apiKey: 'key' },
      { excludedAccountKeys: ['anthropic'] },
      { excludedAccountKeys: Array(101).fill('openai-codex') },
      { failed: { ...event.failed, reason: 'rate-limit' } },
      { failed: { ...event.failed, resetAt: Number.NaN } },
    ]) {
      expect(parseAgentWorkerEvent({ ...event, ...patch })).toBeNull();
    }
  });
  it('结果只能成功账号或终态错误二选一，notice不含凭据', () => {
    const success = {
      type: 'oauth-pool-result',
      requestId: 'request',
      accountKey: 'openai-codex#2',
    };
    expect(parseAgentCommand(success)).toEqual(success);
    expect(
      parseAgentCommand({
        type: 'oauth-pool-result',
        requestId: 'request',
        error: 'No available account',
      })
    ).not.toBeNull();
    expect(parseAgentCommand({ ...success, error: 'both' })).toBeNull();
    const notice = {
      kind: 'oauth-account-selected',
      accountKey: 'openai-codex#2',
      previousAccountKey: 'openai-codex',
      at: 1,
    };
    expect(parseAgentSessionCustomEntry(notice)).toEqual(notice);
    expect(parseAgentSessionCustomEntry({ ...notice, accessToken: 'fixture' })).toBeNull();
  });
});
