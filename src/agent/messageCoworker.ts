import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

export interface MessageCoworkerDeps {
  from: string;
  peers: () => string[];
  notify: (to: string, text: string) => void;
}

function rosterLine(peers: string[]): string {
  return peers.length > 0 ? peers.join(', ') : '(none)';
}

/**
 * coworker → 同父会话另一 coworker。投递走对方会话的 notifier:
 * 闲则唤醒,忙则搭下一轮,不进主管 LLM 正文。
 */
export function createMessageCoworkerTool(deps: MessageCoworkerDeps): ToolDefinition {
  return {
    name: 'message_coworker',
    label: 'Message coworker',
    description:
      'Send a message to another named coworker under the same parent session. ' +
      'Use this for peer coordination; do not route peer chat through the main agent. ' +
      'Delivery is asynchronous: the recipient is woken if idle, otherwise the message ' +
      'piggybacks on its next tool result. Replies arrive later via their message_coworker — ' +
      'continue your own work after sending.',
    promptSnippet:
      'message_coworker: message a peer coworker (to + text). Async; they reply with message_coworker.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient coworker name' },
        text: { type: 'string', description: 'Message body' },
      },
      required: ['to', 'text'],
    } as unknown as ToolDefinition['parameters'],
    async execute(_id, params) {
      const { to, text } = params as { to?: string; text?: string };
      if (!to?.trim()) throw new Error('to is required');
      if (!text?.trim()) throw new Error('text is required');
      const target = to.trim();
      const peers = deps.peers();
      if (target === deps.from) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `(cannot message yourself — peers: ${rosterLine(peers)})`,
            },
          ],
          details: undefined,
        };
      }
      if (!peers.includes(target)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `(unknown coworker "${target}" — peers: ${rosterLine(peers)})`,
            },
          ],
          details: undefined,
        };
      }
      deps.notify(target, `Message from coworker "${deps.from}":\n${text}`);
      return {
        content: [
          {
            type: 'text' as const,
            text: `(delivered to coworker "${target}" — async; any reply arrives later via message_coworker, continue your own work)`,
          },
        ],
        details: undefined,
      };
    },
  };
}
