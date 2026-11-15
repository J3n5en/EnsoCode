import type { PendingProblem, SecretaryResultKind } from '../types/secretary';

/** 一个依赖会话此刻的状态：「真正结束」只有 done 一种 */
export type DependencyState = 'done' | 'waiting' | 'failed' | 'stopped' | 'deleted';

export interface DependencyFacts {
  conversationId: string;
  /** 会话行还在；被删掉的依赖不能再等 */
  present: boolean;
  state: 'running' | 'idle' | 'waiting' | 'error' | 'not-started';
  /** 会话行里的目标状态 */
  goalStatus?: string;
  /** 还有没结束的后台任务：空闲是在等它，不是做完了 */
  backgroundRunning?: boolean;
  /** 最近一次结果 */
  result?: SecretaryResultKind;
  /** 秘书停止过它 */
  stopped: boolean;
  /** 秘书跟踪着它（派出或接管）；没跟踪的只能看会话行判断 */
  tracked: boolean;
}

const SETTLED: ReadonlySet<SecretaryResultKind> = new Set([
  'goal-complete',
  'failed',
  'interrupted',
]);

// 依赖是否真正结束：有目标的会话要 goal-complete 且已空闲，没有目标的会话要回合结束且已空闲。
// 失败、被停止、被删除都算不会再开始。goal-blocked 不算失败：它在等用户，
// 秘书会收到它自己的结果并决定要不要取消这条派发。
export function dependencyState(facts: DependencyFacts): DependencyState {
  if (!facts.present) return 'deleted';
  if (facts.stopped) return 'stopped';
  if (facts.state === 'error' || facts.result === 'failed') return 'failed';
  if (facts.result === 'interrupted') return 'stopped';
  const idle = facts.state === 'idle' && facts.backgroundRunning !== true;
  if (!idle) return 'waiting';
  if (facts.result === 'goal-complete') return 'done';
  if (facts.goalStatus === 'completed') return 'done';
  // 没有目标的会话：回合结束且已空闲。没跟踪的会话看不到结果，空闲就算结束
  if (facts.goalStatus === undefined && (!facts.tracked || facts.result === 'turn-ended')) {
    return 'done';
  }
  return 'waiting';
}

export type PendingOutcome =
  | { kind: 'wait' }
  | { kind: 'start' }
  | { kind: 'failed'; problem: PendingProblem; conversationId: string };

const PROBLEM_OF: Record<Exclude<DependencyState, 'done' | 'waiting'>, PendingProblem> = {
  failed: 'dependency-failed',
  stopped: 'dependency-stopped',
  deleted: 'dependency-deleted',
};

/** 按 after 的顺序判定：任何一个依赖出问题就整条不启动，全部真正结束才开始 */
export function pendingOutcome(deps: readonly DependencyFacts[]): PendingOutcome {
  let waiting = false;
  for (const facts of deps) {
    const state = dependencyState(facts);
    if (state === 'waiting') {
      waiting = true;
      continue;
    }
    if (state === 'done') continue;
    return {
      kind: 'failed',
      problem: PROBLEM_OF[state],
      conversationId: facts.conversationId,
    };
  }
  return waiting ? { kind: 'wait' } : { kind: 'start' };
}

/** 结果已经收口：这类会话不会再自己动起来 */
export function settledResult(result: SecretaryResultKind | undefined): boolean {
  return result !== undefined && SETTLED.has(result);
}
