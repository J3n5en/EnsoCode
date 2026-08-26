import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

export type GoalSignalKind = 'complete' | 'blocked' | 'wait';

/**
 * goal 终止信号工具(借鉴 pi-goal):goal 模式下 agent 用它们明确收束,
 * 而不是被续跑循环盲目推着走。信号经事件上抛,goal 状态机在渲染层。
 */
export function createGoalTools(
  emit: (kind: GoalSignalKind, note: string) => void
): ToolDefinition[] {
  const make = (
    name: string,
    kind: GoalSignalKind,
    description: string,
    noteField: string,
    noteDesc: string
  ): ToolDefinition => ({
    name,
    label: name,
    description,
    promptSnippet: '',
    parameters: {
      type: 'object',
      properties: { [noteField]: { type: 'string', description: noteDesc } },
      required: [noteField],
    } as unknown as ToolDefinition['parameters'],
    async execute(_id, params) {
      const note = String((params as Record<string, unknown>)[noteField] ?? '').trim();
      if (!note) throw new Error(`${noteField} is required`);
      emit(kind, note);
      return {
        content: [{ type: 'text' as const, text: `Goal marked ${kind}.` }],
        details: undefined,
      };
    },
  });

  return [
    make(
      'goal_complete',
      'complete',
      'Mark the active session goal as COMPLETE. Only call when a goal is active (its text appears ' +
        'in your context) and the objective is genuinely done — include concrete evidence.',
      'summary',
      'What was accomplished, with concrete evidence (files changed, tests passing, etc.)'
    ),
    make(
      'goal_blocked',
      'blocked',
      'Mark the active session goal as BLOCKED: you cannot proceed without user input or an ' +
        'external change. Only call when a goal is active.',
      'reason',
      'What is blocking progress and what is needed to unblock'
    ),
    make(
      'goal_wait',
      'wait',
      'Pause the active session goal to WAIT for something external (CI, deploy, another agent). ' +
        'Only call when a goal is active. The user can resume the goal later.',
      'reason',
      'What you are waiting for and how to tell when it is ready'
    ),
  ];
}
