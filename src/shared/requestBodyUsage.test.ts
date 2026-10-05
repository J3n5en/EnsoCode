import { describe, expect, it } from 'vitest';
import { parseRequestBodyUsage } from './requestBodyUsage';
import { parseAgentWorkerEvent, parseSessionSnapshot } from './types/agent';

const usage = { bytes: 25, limitBytes: 100, stage: 'wire', blocked: false, at: 10 };
const identity = { sessionId: 'body-fixture', generation: '11111111-1111-4111-8111-111111111111' };

describe('请求体遥测信任边界', () => {
  it('合法值与本地阻止值完整保留，不使用 token 数冒充字节', () => {
    expect(parseRequestBodyUsage(usage)).toEqual(usage);
    const blocked = { ...usage, bytes: 101, stage: 'payload', blocked: true };
    expect(parseRequestBodyUsage(blocked)).toEqual(blocked);
  });
  it.each([
    null,
    [],
    {},
    { ...usage, bytes: -1 },
    { ...usage, bytes: 1.5 },
    { ...usage, bytes: Infinity },
    { ...usage, limitBytes: 0 },
    { ...usage, limitBytes: NaN },
    { ...usage, at: -1 },
    { ...usage, stage: 'estimated' },
    { ...usage, blocked: true },
    { ...usage, bytes: 101 },
    { ...usage, payload: 'private' },
    { ...usage, apiKey: 'private' },
  ])('坏计量与任何正文/凭证字段拒绝：%j', (value) => {
    expect(parseRequestBodyUsage(value)).toBeNull();
  });
  it('新事件合法往返，身份、seq、正文或坏用量均不能绕过 Main 白名单', () => {
    const event = { type: 'request-body', identity, seq: 1, usage };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
    for (const patch of [
      { seq: -1 },
      { identity: { sessionId: 'x' } },
      { payload: 'private' },
      { usage: { ...usage, bytes: '25' } },
    ])
      expect(parseAgentWorkerEvent({ ...event, ...patch })).toBeNull();
  });
  it('快照携带计量可重建，脏用量拒绝而旧无计量快照保持兼容', () => {
    const snapshot = { identity, status: 'idle', messages: [], commands: [], requestBody: usage };
    expect(parseSessionSnapshot(snapshot)).toEqual(snapshot);
    expect(
      parseSessionSnapshot({ ...snapshot, requestBody: { ...usage, apiKey: 'private' } })
    ).toBeNull();
    expect(parseSessionSnapshot({ ...snapshot, requestBody: undefined })).not.toBeNull();
  });
});
