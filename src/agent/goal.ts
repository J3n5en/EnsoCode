import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { GOAL_RESULT_SCHEMA, type GoalResult, parseGoalResult } from '@shared/secretary/goalResult';

export type GoalSignalKind = 'complete' | 'blocked' | 'wait';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/** 模型常把 result 再套成 JSON 字符串。schema 校验前还原成对象。 */
export function prepareGoalComplete(raw: unknown): unknown {
  const source = typeof raw === 'string' ? parseJson(raw) : raw;
  if (!isRecord(source)) return raw;
  if (typeof source.result !== 'string') return source;
  const result = parseJson(source.result);
  if (!isRecord(result)) return source;
  return { ...source, result };
}

/**
 * goal 终止信号工具(借鉴 pi-goal):goal 模式下 agent 用它们明确收束,
 * 而不是被续跑循环盲目推着走。信号经事件上抛,goal 状态机在渲染层。
 * verify 是 goal_complete 的独立核验：返回驳回理由时不发信号，理由交还模型补证据。
 */
export function createGoalTools(
  emit: (kind: GoalSignalKind, note: string, result?: GoalResult) => void,
  verify?: (summary: string, signal: AbortSignal | undefined) => Promise<string | undefined>,
  /** goal_complete 成功后附在结果后的收尾提示（如还在跑、没表态的后台任务清单） */
  completionNote?: () => string | undefined
): ToolDefinition[] {
  const make = (
    name: string,
    kind: GoalSignalKind,
    description: string,
    noteField: string,
    noteDesc: string,
    withResult = false
  ): ToolDefinition => ({
    name,
    label: name,
    description,
    promptSnippet: '',
    ...(withResult
      ? {
          prepareArguments: prepareGoalComplete as unknown as ToolDefinition['prepareArguments'],
        }
      : {}),
    parameters: {
      type: 'object',
      properties: withResult
        ? {
            [noteField]: { type: 'string', description: noteDesc },
            result: {
              ...GOAL_RESULT_SCHEMA,
              description:
                'Optional structured outcome (pull requests, commits, checks, screenshots) for a read-only host check',
            },
          }
        : { [noteField]: { type: 'string', description: noteDesc } },
      required: [noteField],
    } as unknown as ToolDefinition['parameters'],
    async execute(_id, params, signal) {
      const record = isRecord(params) ? params : {};
      const note = String(record[noteField] ?? '').trim();
      if (!note) throw new Error(`${noteField} is required`);
      let goalResult: GoalResult | undefined;
      if (withResult && record.result !== undefined) {
        const parsed = parseGoalResult(record.result);
        if (!parsed.ok) {
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `Goal NOT marked complete — result is invalid: ${parsed.error}\n` +
                  'Fix that field and call goal_complete again. Omit result for a plain summary.',
              },
            ],
            details: undefined,
          };
        }
        goalResult = parsed.value;
      }
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
      if (goalResult) emit(kind, note, goalResult);
      else emit(kind, note);
      const extra = kind === 'complete' ? completionNote?.() : undefined;
      return {
        content: [
          {
            type: 'text' as const,
            text: extra ? `Goal marked ${kind}.\n\n${extra}` : `Goal marked ${kind}.`,
          },
        ],
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
        'when something is ambiguous, take the most likely reading, state the assumption, and keep going. ' +
        'Optional result carries structured evidence (pull requests, commits, checks, screenshots) for a read-only host check; a plain summary still completes the goal. ' +
        'result.needsUser lists only what the user must decide or do by hand, one imperative sentence each; optional cleanup and suggestions go in result.followUps. ' +
        'For a session dispatched or tracked by a secretary, needsUser goes to the secretary first, which handles what it can and passes on the rest, so write it as it is and do not inflate it.',
      'summary',
      'What was accomplished, with concrete evidence (files changed, tests passing, etc.)',
      true
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
