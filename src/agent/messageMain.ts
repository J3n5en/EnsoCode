import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

/**
 * coworker → 主 agent 的主动消息工具。经 ParentNotifier 合并投递:
 * 父闲则合成提示唤醒,忙则搭下一次工具结果送达,绝不打断父的当前轮。
 */
export function createMessageMainTool(
  notify: (text: string, urgent?: boolean) => void,
  coworkerName: string
): ToolDefinition {
  return {
    name: 'message_main_agent',
    label: 'Message main agent',
    description:
      'Send a message to the main agent (your supervisor). Use it to hand off work that belongs to ' +
      'the main session, report findings proactively, or ask the main agent to act. Delivery is ' +
      'asynchronous: the main agent is woken if idle, otherwise the message piggybacks on its next ' +
      'tool result. This tool has no reply channel: replies arrive as a new message via coworker send, ' +
      'so continue your own work after sending and act on the reply when it comes.',
    promptSnippet:
      'message_main_agent: proactively message the main agent (hand off tasks, report findings). ' +
      'Async, no reply channel — continue your own work after sending.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message for the main agent' },
        urgent: {
          type: 'boolean',
          description: 'Deliver immediately without batching (failures, blockers)',
        },
      },
      required: ['message'],
    } as unknown as ToolDefinition['parameters'],
    async execute(_id, params) {
      const { message, urgent } = params as { message: string; urgent?: boolean };
      if (!message?.trim()) throw new Error('message is required');
      notify(`Message from coworker "${coworkerName}":\n${message}`, urgent === true);
      return {
        content: [
          {
            type: 'text' as const,
            text: '(delivered to the main agent — async; any reply arrives as a new message via coworker send, continue your own work)',
          },
        ],
        details: undefined,
      };
    },
  };
}
