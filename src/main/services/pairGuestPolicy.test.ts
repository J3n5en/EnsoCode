import { describe, expect, it } from 'vitest';
import { parseGuestOutbound } from './pairGuestPolicy';

/** 渲染层经 NODES_SEND 发给远程节点的命令：结构复用手机白名单，再收窄掉桌面不该发的 */
describe('parseGuestOutbound', () => {
  it('放行手机同款业务命令', () => {
    for (const cmd of [
      { type: 'prompt', sessionId: 's', text: 'hi' },
      { type: 'steer', sessionId: 's', text: 'hi' },
      { type: 'abort', sessionId: 's' },
      { type: 'approval-respond', sessionId: 's', requestId: 'r', decision: 'allow' },
      { type: 'ask-respond', sessionId: 's', requestId: 'r', answer: 'a' },
      { type: 'snapshot' },
      { type: 'subscribe', sessionId: 's', sinceIndex: 3 },
      { type: 'subscribe', sessionId: null },
      { type: 'spawn', sessionId: 's', projectId: 'p', providerId: 'pr', modelId: 'm' },
      { type: 'set-model', sessionId: 's', providerId: 'pr', modelId: 'm' },
      { type: 'set-reasoning', sessionId: 's', enabled: true },
      { type: 'set-thinking', sessionId: 's', level: 'high' },
      { type: 'history', sessionId: 's', beforeIndex: 10 },
      { type: 'presence', visible: true },
    ]) {
      expect(parseGuestOutbound(cmd).ok, cmd.type).toBe(true);
    }
  });

  it('拒绝 Web Push 登记：桌面没有 pushManager，不该往对方机器塞订阅', () => {
    expect(
      parseGuestOutbound({
        type: 'push-subscribe',
        subscription: { endpoint: 'https://x', keys: { p256dh: 'a', auth: 'b' } },
      }).ok
    ).toBe(false);
    expect(parseGuestOutbound({ type: 'push-unsubscribe' }).ok).toBe(false);
  });

  it('结构不合法一律拒绝（沿用手机白名单校验）', () => {
    expect(parseGuestOutbound(null).ok).toBe(false);
    expect(parseGuestOutbound({ type: 'prompt', sessionId: 's', text: '' }).ok).toBe(false);
    expect(parseGuestOutbound({ type: 'spawn', sessionId: 's', cwd: '/etc' }).ok).toBe(false);
    expect(parseGuestOutbound({ type: 'set-approval-mode', sessionId: 's' }).ok).toBe(false);
  });
});
