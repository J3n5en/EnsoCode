import { describe, expect, it } from 'vitest';
import { parseAgentCommand, parseAgentWorkerEvent } from './agent';

const parent = {
  sessionId: 'conversation-1',
  generation: '11111111-1111-4111-8111-111111111111',
} as const;
const model = {
  api: 'openai-responses',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'k',
  modelId: 'gpt',
  settingsProviderId: 'provider-entry-1',
};
const tool = {
  name: 'plugin_example-demo__lookup',
  description: '查询',
  parameters: { type: 'object' },
  pluginId: 'example.demo',
};
const spawn = (pluginTools: unknown) => ({
  type: 'spawn-parent',
  identity: parent,
  cwd: '/repo',
  model,
  pluginTools,
});

describe('插件工具协议', () => {
  it('spawn-parent 接受合法 pluginTools', () => {
    expect(parseAgentCommand(spawn([tool]))).not.toBeNull();
    expect(parseAgentCommand(spawn([{ ...tool, timeoutMs: 1000 }]))).not.toBeNull();
    expect(parseAgentCommand(spawn([{ ...tool, timeoutMs: 600_000 }]))).not.toBeNull();
  });

  it.each([
    ['非数组', 'x'],
    ['名称与插件 id 不符', [{ ...tool, pluginId: 'other.demo' }]],
    ['不是插件工具名', [{ ...tool, name: 'bash' }]],
    ['parameters 非对象', [{ ...tool, parameters: 'x' }]],
    ['多余字段', [{ ...tool, extra: 1 }]],
    ['重名', [tool, tool]],
    ['超时过小', [{ ...tool, timeoutMs: 999 }]],
    ['超时过大', [{ ...tool, timeoutMs: 600_001 }]],
    ['超时不是整数', [{ ...tool, timeoutMs: 1500.5 }]],
  ])('spawn-parent 拒绝脏 pluginTools：%s', (_label, value) => {
    expect(parseAgentCommand(spawn(value))).toBeNull();
  });

  const plan = {
    observe: ['session_start', 'before_compact'],
    intercept: [{ event: 'tool_call', tools: ['bash'] }, { event: 'input' }],
    inject: true,
  };

  it('spawn-parent 接受 pluginEvents，可拦截事件也能只观察', () => {
    for (const pluginEvents of [plan, { ...plan, observe: ['tool_call', 'input'] }]) {
      expect(
        parseAgentCommand({ ...spawn(undefined), pluginTools: undefined, pluginEvents })
      ).not.toBeNull();
    }
  });

  it.each([
    ['before_compact 之外的未知事件', { ...plan, observe: ['nope'] }],
    ['重复订阅', { ...plan, observe: ['session_start', 'session_start'] }],
    ['未知事件', { ...plan, intercept: [{ event: 'session_end' }] }],
    ['inject 不是布尔', { ...plan, inject: 'yes' }],
    ['多余字段', { ...plan, extra: true }],
  ])('spawn-parent 拒绝脏 pluginEvents：%s', (_label, pluginEvents) => {
    expect(
      parseAgentCommand({
        type: 'spawn-parent',
        identity: parent,
        cwd: '/repo',
        model,
        pluginEvents,
      })
    ).toBeNull();
  });

  it('plugin-event / plugin-intercept 事件', () => {
    expect(
      parseAgentWorkerEvent({
        type: 'plugin-event',
        identity: parent,
        seq: 1,
        event: 'session_start',
        data: { reason: 'startup' },
      })
    ).not.toBeNull();
    expect(
      parseAgentWorkerEvent({
        type: 'plugin-event',
        identity: parent,
        seq: 1,
        event: 'before_compact',
        data: { reason: 'manual' },
      })
    ).toBeNull();
    expect(
      parseAgentWorkerEvent({
        type: 'plugin-event',
        identity: parent,
        seq: 1,
        event: 'agent_start',
        data: { extra: 1 },
      })
    ).toBeNull();
    expect(
      parseAgentWorkerEvent({
        type: 'plugin-intercept',
        identity: parent,
        seq: 2,
        requestId: 'r1',
        event: 'tool_call',
        payload: { toolCallId: 'c1', toolName: 'bash', input: { command: 'ls' } },
      })
    ).not.toBeNull();
    for (const [event, data] of [
      ['tool_call', { toolCallId: 'c1', toolName: 'bash', input: {} }],
      [
        'tool_result',
        { toolCallId: 'c1', toolName: 'bash', input: {}, content: 'ok', isError: false },
      ],
      ['input', { text: 'hi', source: 'interactive' }],
    ] as const) {
      expect(
        parseAgentWorkerEvent({ type: 'plugin-event', identity: parent, seq: 3, event, data })
      ).not.toBeNull();
    }
    expect(
      parseAgentWorkerEvent({
        type: 'plugin-event',
        identity: parent,
        seq: 3,
        event: 'tool_call',
        data: { toolName: 'bash' },
      })
    ).toBeNull();
    expect(
      parseAgentWorkerEvent({
        type: 'plugin-intercept',
        identity: parent,
        seq: 2,
        requestId: 'r1',
        event: 'tool_call',
        payload: { toolName: 'bash' },
      })
    ).toBeNull();
  });

  it('plugin-intercept-result / progress / inject 命令', () => {
    expect(
      parseAgentCommand({
        type: 'plugin-intercept-result',
        identity: parent,
        requestId: 'r1',
        ok: true,
        result: { block: true },
      })
    ).not.toBeNull();
    expect(
      parseAgentCommand({
        type: 'plugin-intercept-result',
        identity: parent,
        requestId: 'r1',
        ok: false,
        result: {},
      })
    ).toBeNull();
    expect(
      parseAgentCommand({
        type: 'plugin-tool-progress',
        identity: parent,
        requestId: 'r1',
        text: 'x'.repeat(16 * 1024),
      })
    ).not.toBeNull();
    expect(
      parseAgentCommand({
        type: 'plugin-tool-progress',
        identity: parent,
        requestId: 'r1',
        text: 'x'.repeat(16 * 1024 + 1),
      })
    ).toBeNull();
    expect(
      parseAgentCommand({
        type: 'plugin-inject',
        identity: parent,
        pluginId: 'example.demo',
        pluginName: 'Demo',
        text: 'hello',
        deliverAs: 'nextTurn',
        triggerTurn: false,
      })
    ).not.toBeNull();
    expect(
      parseAgentCommand({
        type: 'plugin-inject',
        identity: parent,
        pluginId: 'example.demo',
        pluginName: 'Demo',
        text: 'x'.repeat(32 * 1024 + 1),
        deliverAs: 'steer',
        triggerTurn: true,
      })
    ).toBeNull();
    expect(
      parseAgentCommand({
        type: 'plugin-inject',
        identity: parent,
        pluginId: 'example.demo',
        pluginName: 'Demo',
        text: 'hello',
        deliverAs: 'now',
        triggerTurn: false,
      })
    ).toBeNull();
  });

  it('plugin-tool-result 成功与失败两种形状', () => {
    const base = { type: 'plugin-tool-result', identity: parent, requestId: 'r1' };
    expect(parseAgentCommand({ ...base, ok: true, result: { content: 'x' } })).not.toBeNull();
    expect(parseAgentCommand({ ...base, ok: false, error: 'bad' })).not.toBeNull();
    expect(parseAgentCommand({ ...base, ok: false, result: {} })).toBeNull();
  });

  it('plugin-tool-invoke / cancel 事件', () => {
    const invoke = {
      type: 'plugin-tool-invoke',
      identity: parent,
      seq: 1,
      requestId: 'r1',
      toolName: tool.name,
      args: {},
    };
    expect(parseAgentWorkerEvent(invoke)).not.toBeNull();
    expect(parseAgentWorkerEvent({ ...invoke, toolName: 'bash' })).toBeNull();
    expect(
      parseAgentWorkerEvent({
        type: 'plugin-tool-cancel',
        identity: parent,
        seq: 2,
        requestId: 'r1',
      })
    ).not.toBeNull();
  });

  it('投影消息的插件来源必须完整合法', () => {
    const snapshot = (pluginSource: unknown) =>
      parseAgentWorkerEvent({
        type: 'message-upsert',
        identity: parent,
        seq: 9,
        index: 0,
        message: { role: 'custom', content: [], pluginSource },
      });
    expect(snapshot({ pluginId: 'enso.example.notes', pluginName: 'Notes' })).not.toBeNull();
    expect(snapshot({ pluginId: 'enso.example.notes' })).toBeNull();
    expect(snapshot({ pluginId: '../x', pluginName: 'N' })).toBeNull();
  });

  describe('子会话来源 agent', () => {
    const childIdentity = {
      sessionId: 'conversation-1::cw-scout',
      generation: '22222222-2222-4222-8222-222222222222',
    };
    const agent = {
      kind: 'subagent',
      sessionId: childIdentity.sessionId,
      name: 'Scout-1',
      agentType: 'Scout',
    };
    const invoke = {
      type: 'plugin-tool-invoke',
      identity: childIdentity,
      seq: 1,
      requestId: 'r1',
      toolName: tool.name,
      args: {},
    };
    const event = {
      type: 'plugin-event',
      identity: childIdentity,
      seq: 1,
      event: 'agent_end',
      data: {},
    };

    it('plugin-tool-invoke / plugin-event 接受与 identity 一致的来源', () => {
      expect(parseAgentWorkerEvent({ ...invoke, agent })).not.toBeNull();
      expect(parseAgentWorkerEvent({ ...event, agent })).not.toBeNull();
      const { agentType: _omit, ...coworker } = { ...agent, kind: 'coworker' };
      expect(parseAgentWorkerEvent({ ...invoke, agent: coworker })).not.toBeNull();
    });

    it.each([
      ['来源不是本会话', { ...agent, sessionId: 'conversation-1::cw-other' }],
      ['主会话冒充子会话', { ...agent, sessionId: 'conversation-1' }],
      ['未知类型', { ...agent, kind: 'main' }],
      ['缺名字', { ...agent, name: '' }],
      ['多余字段', { ...agent, extra: 1 }],
    ])('拒绝脏来源：%s', (_label, bad) => {
      expect(parseAgentWorkerEvent({ ...invoke, agent: bad })).toBeNull();
      expect(parseAgentWorkerEvent({ ...event, agent: bad })).toBeNull();
    });

    it('子会话的 before_compact 走通知通道，主会话仍不允许', () => {
      const compact = { ...event, event: 'before_compact', data: { reason: 'threshold' } };
      expect(parseAgentWorkerEvent({ ...compact, agent })).not.toBeNull();
      expect(parseAgentWorkerEvent(compact)).toBeNull();
      expect(parseAgentWorkerEvent({ ...compact, agent, data: {} })).toBeNull();
    });

    it('子会话的拦截只接受带来源的 tool_call；其余事件与脏来源拒绝', () => {
      const intercept = {
        type: 'plugin-intercept',
        identity: childIdentity,
        seq: 1,
        requestId: 'r1',
        event: 'tool_call',
        payload: { toolCallId: 'c', toolName: 'bash', input: {} },
      };
      expect(parseAgentWorkerEvent({ ...intercept, agent })).not.toBeNull();
      expect(
        parseAgentWorkerEvent({
          ...intercept,
          agent,
          event: 'tool_result',
          payload: { toolCallId: 'c', toolName: 'bash', input: {}, content: '', isError: false },
        })
      ).toBeNull();
      expect(
        parseAgentWorkerEvent({
          ...intercept,
          agent,
          event: 'input',
          payload: { text: 'hi', source: 'interactive' },
        })
      ).toBeNull();
      expect(
        parseAgentWorkerEvent({
          ...intercept,
          agent,
          event: 'before_compact',
          payload: { reason: 'threshold' },
        })
      ).toBeNull();
      expect(
        parseAgentWorkerEvent({
          ...intercept,
          agent: { ...agent, sessionId: 'conversation-1::cw-other' },
        })
      ).toBeNull();
    });
  });
});
