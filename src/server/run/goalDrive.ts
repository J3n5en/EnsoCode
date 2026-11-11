import {
  goalKickoffText,
  type HeadlessDelivery,
  type HeadlessSessionRuntime,
  onHeadlessIdle,
} from '@shared/pair/headlessQueue';

export function normalizeAssistantOutput(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 首条用户消息。只有 goal 时用 kickoff；两者都有且不同则拼在一起。 */
export function initialPrompt(prompt: string, goal: string | undefined): string {
  const objective = goal?.trim();
  const text = prompt.trim();
  if (objective && text && text !== objective) return `${text}\n\n${goalKickoffText(objective)}`;
  if (objective) return goalKickoffText(objective);
  return text;
}

export interface GoalStepInput {
  runtime: HeadlessSessionRuntime;
  assistantText: string;
  lastOutput: string;
  noProgressRuns: number;
  autoTurnLimit: number;
}

export interface GoalStep {
  runtime: HeadlessSessionRuntime;
  deliver?: HeadlessDelivery;
  lastOutput: string;
  noProgressRuns: number;
}

/**
 * 一轮结束后决定是否续跑。连续 3 次最终回复为空或相同则暂停，
 * 与桌面 goal 的无进展守卫同一口径。
 */
export function nextGoalStep(input: GoalStepInput): GoalStep {
  const goal = input.runtime.goal;
  if (goal?.status !== 'active') {
    return {
      runtime: input.runtime,
      lastOutput: input.lastOutput,
      noProgressRuns: input.noProgressRuns,
    };
  }
  const output = normalizeAssistantOutput(input.assistantText);
  const stuck = output === '' || output === input.lastOutput;
  const noProgressRuns = stuck ? input.noProgressRuns + 1 : 0;
  if (noProgressRuns >= 3) {
    return {
      runtime: {
        ...input.runtime,
        goal: { ...goal, status: 'paused', note: 'no progress in 3 consecutive runs' },
      },
      lastOutput: output,
      noProgressRuns,
    };
  }
  const idle = onHeadlessIdle(
    { ...input.runtime, status: 'idle', started: true, pendingApprovals: 0, pendingAsks: 0 },
    { autoTurnLimit: input.autoTurnLimit }
  );
  return {
    runtime: idle.runtime,
    ...(idle.deliver ? { deliver: idle.deliver } : {}),
    lastOutput: output,
    noProgressRuns,
  };
}
