import { describe, expect, it } from 'vitest';
import { parseAgentCommand, parseAgentWorkerEvent } from './agent';
import { model, parent } from './agent.testUtils';

const spawn = {
  type: 'spawn-parent',
  identity: parent,
  cwd: '/workspace',
  model,
  secretaryMode: true,
} as const;

describe('secretary worker protocol', () => {
  it('spawn-parent 接受 secretaryMode 布尔，拒绝其他类型与多余键', () => {
    expect(parseAgentCommand(spawn)).toEqual(spawn);
    expect(parseAgentCommand({ ...spawn, secretaryMode: 'yes' })).toBeNull();
    expect(parseAgentCommand({ ...spawn, secretary: true })).toBeNull();
  });

  it('secretary-invoke 只接受已登记的 op', () => {
    const event = {
      type: 'secretary-invoke',
      identity: parent,
      seq: 3,
      requestId: 's-1',
      op: 'session_read',
      params: { conversationId: 'c1' },
    };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
    expect(parseAgentWorkerEvent({ ...event, op: 'shell_exec' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, extra: 1 })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, identity: { ...parent, sessionId: '' } })).toBeNull();
    const toolRun = { ...event, op: 'tool_run', params: { name: 'upper-text', arguments: {} } };
    expect(parseAgentWorkerEvent(toolRun)).toEqual(toolRun);
  });

  it('ask-resolved 的 needsUser 关联：合格的归一放行，坏的或缺提问时间只剥掉关联，事件照常', () => {
    const base = { type: 'ask-resolved', identity: parent, seq: 4, requestId: 'ask-1', by: 'user' };
    const link = { conversationId: 'c1', needsUserIndex: 0 };
    expect(parseAgentWorkerEvent({ ...base, relatesTo: link, askedAt: 9 })).toEqual({
      ...base,
      relatesTo: link,
      askedAt: 9,
    });
    expect(
      parseAgentWorkerEvent({
        ...base,
        relatesTo: { conversationId: 'c1', needsUserIndex: -1 },
        askedAt: 9,
      })
    ).toEqual(base);
    expect(parseAgentWorkerEvent({ ...base, relatesTo: link })).toEqual(base);
  });

  it('spawn-parent 接受秘书自造工具描述符，形状不对整批拒绝', () => {
    const descriptor = {
      name: 'my_upper_text',
      description: '把文本转成大写',
      parameters: { type: 'object', properties: {} },
      readOnly: true,
    };
    const withTools = { ...spawn, secretaryTools: [descriptor] } as const;
    expect(parseAgentCommand(withTools)).toEqual(withTools);
    expect(
      parseAgentCommand({ ...spawn, secretaryTools: [{ ...descriptor, name: 'bash' }] })
    ).toBeNull();
    expect(
      parseAgentCommand({ ...spawn, secretaryTools: [{ ...descriptor, readOnly: 'yes' }] })
    ).toBeNull();
  });

  it('secretary-result 成功不带 error，失败必须带 error 且不带 result', () => {
    const ok = {
      type: 'secretary-result',
      identity: parent,
      requestId: 's-1',
      ok: true,
      result: {},
    };
    expect(parseAgentCommand(ok)).toEqual(ok);
    const failed = {
      type: 'secretary-result',
      identity: parent,
      requestId: 's-1',
      ok: false,
      error: 'unavailable',
    };
    expect(parseAgentCommand(failed)).toEqual(failed);
    expect(parseAgentCommand({ ...ok, error: 'boom' })).toBeNull();
    expect(parseAgentCommand({ ...failed, error: '' })).toBeNull();
    expect(parseAgentCommand({ ...failed, result: {} })).toBeNull();
    expect(parseAgentCommand({ ...ok, extra: 1 })).toBeNull();
  });
});
