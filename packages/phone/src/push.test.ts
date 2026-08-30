import { describe, expect, it } from 'vitest';
import { classifyPushError } from './push';

describe('classifyPushError', () => {
  it('AbortError（push service error）归类为推送服务不可达', () => {
    expect(classifyPushError('AbortError')).toBe('service-unreachable');
  });

  it('NotAllowedError 归类为权限被拒', () => {
    expect(classifyPushError('NotAllowedError')).toBe('permission-denied');
  });

  it('其余错误归类为订阅失败', () => {
    expect(classifyPushError('InvalidStateError')).toBe('subscribe-failed');
    expect(classifyPushError('TypeError')).toBe('subscribe-failed');
    expect(classifyPushError('')).toBe('subscribe-failed');
  });
});
