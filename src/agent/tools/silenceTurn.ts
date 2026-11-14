import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { SILENCE_TURN_TOOL } from '@shared/secretary/silence';

/** 无参数。只表示「这一轮不用打扰用户」，不改任何状态。 */
export function createSilenceTurnTool(): ToolDefinition {
  return {
    name: SILENCE_TURN_TOOL,
    label: 'Silence turn',
    description:
      'End this turn without disturbing the user. Use only for a system <session-updates> or <secretary-schedule> message that needs no action: a normal patrol, intermediate progress, or a false alarm. Call it and stop. Do not write any other text. It does not silence a message the user typed themselves.',
    promptSnippet:
      'silence_turn: system update needs nothing from the user — call it and stop, with no other text. Never use it to answer the user.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    } as unknown as ToolDefinition['parameters'],
    annotations: { readOnlyHint: true },
    async execute() {
      return {
        content: [
          {
            type: 'text',
            text: 'Silenced. Stop this turn now and do not write any other text.',
          },
        ],
        details: { silenced: true },
      };
    },
  };
}
