import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

export type GoalSignalKind = 'complete' | 'blocked' | 'wait';

/**
 * goal 终止信号工具(借鉴 pi-goal):goal 模式下 agent 用它们明确收束,
 * 而不是被续跑循环盲目推着走。信号经事件上抛,goal 状态机在渲染层。
 * verify 是 goal_complete 的独立核验：返回驳回理由时不发信号，理由交还模型补证据。
 */
export function createGoalTools(
  emit: (kind: GoalSignalKind, note: string) => void,
  verify?: (summary: string, signal: AbortSignal | undefined) => Promise<string | undefined>
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
    async execute(_id, params, signal) {
      const note = String((params as Record<string, unknown>)[noteField] ?? '').trim();
      if (!note) throw new Error(`${noteField} is required`);
      if (kind === 'complete' && verify) {
        const rejection = await verify(note, signal);
        if (rejection)
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `Goal NOT marked complete — an independent verifier rejected it: ${rejection}\n` +
                  'The goal is still active. Produce the missing proof with tools (run the check, show the decisive output), ' +
                  'or keep working; then call goal_complete again. If it truly cannot be proven, call goal_blocked.',
              },
            ],
            details: undefined,
          };
      }
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
        'in your context) and the objective is genuinely done — include concrete evidence. ' +
        'An independent verifier checks the claim against the transcript: prove each requirement with a ' +
        'recent tool result (run the check and show its output); your own statements do not count as proof. ' +
        'While a goal runs, nobody is watching each step: do not stop at analysis or a plan; ' +
        'when something is ambiguous, take the most likely reading, state the assumption, and keep going.',
      'summary',
      'What was accomplished, with concrete evidence (files changed, tests passing, etc.)'
    ),
    make(
      'goal_blocked',
      'blocked',
      'Mark the active session goal as BLOCKED: you cannot proceed without user input or an ' +
        'external change. Only call when a goal is active. Blocked means missing access, credentials, ' +
        'or a decision only the user can make — not ambiguity you can resolve yourself. Finish every ' +
        'part that is not blocked first, and lead the reason with what exactly is stuck.',
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
