import { STALE_SESSION_ERROR } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import { rejectUnparsableCommand } from './commandRejection';

const parent = { sessionId: 'parent', generation: '11111111-1111-4111-8111-111111111111' };
const child = {
  sessionId: 'parent::cw',
  generation: '33333333-3333-4333-8333-333333333333',
  parent,
  instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  instanceName: 'cw',
  typeKey: 'builtin:worker',
};
const instanceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('rejectUnparsableCommand', () => {
  it('spawn-parent / prompt 解析失败回发 parent-rejected，带实例号且不冒充 stale', () => {
    const event = rejectUnparsableCommand({ type: 'spawn-parent', identity: parent, instanceId });
    expect(event).toMatchObject({ type: 'parent-rejected', identity: parent, seq: 0, instanceId });
    expect(event && 'reason' in event && event.reason).toContain('spawn-parent');
    expect(event && 'reason' in event && event.reason.startsWith(STALE_SESSION_ERROR)).toBe(false);
    expect(rejectUnparsableCommand({ type: 'prompt', identity: parent })).toMatchObject({
      type: 'parent-rejected',
      identity: parent,
    });
  });

  it('子会话身份回发 child-rejected', () => {
    for (const type of ['spawn-child', 'prompt', 'steer', 'retry']) {
      expect(rejectUnparsableCommand({ type, identity: child })).toMatchObject({
        type: 'child-rejected',
        identity: child,
        seq: 0,
      });
    }
  });

  it('无会话身份、身份不合法或非会话命令不回发', () => {
    expect(rejectUnparsableCommand(null)).toBeNull();
    expect(rejectUnparsableCommand({ type: 'spawn-parent' })).toBeNull();
    expect(
      rejectUnparsableCommand({ type: 'spawn-parent', identity: { sessionId: 'x' } })
    ).toBeNull();
    expect(rejectUnparsableCommand({ type: 'set-plan-mode', identity: parent })).toBeNull();
    expect(rejectUnparsableCommand({ type: 'spawn-child', identity: parent })).toBeNull();
    expect(rejectUnparsableCommand({ type: 'spawn-parent', identity: child })).toBeNull();
  });
});
