// 子代理单次 Run 的模型请求软预算。
// 只数这次 Run 里子代理自己发出的模型请求（assistant 回合）；coworker 每次新 Run 重新计数。
// 主会话和 Bot 成员不走这里。默认写死，0 表示关闭。
export const SOFT_REQUEST_BUDGET = 200;

/** 到达 1.5 倍强制交出后，再留这么多次请求让交出那一步落地，用完仍不交就硬停。 */
export const BUDGET_STOP_GRACE_REQUESTS = 5;

export function budgetStopThreshold(soft: number = SOFT_REQUEST_BUDGET): number {
  return Math.ceil(soft * 1.5);
}

export type BudgetPhase = 'idle' | 'running' | 'stopping' | 'wrapup' | 'done';

/** notice：到软预算，注入一次收尾提示；stop：到 1.5 倍，中止自由回合并强制交出；hard：宽限耗尽，硬停。 */
export type BudgetAction = 'notice' | 'stop' | 'hard';

export function budgetNoticeText(requests: number, budget: number): string {
  return (
    `[request budget] You have used ${requests} model requests in this run ` +
    `(soft budget: ${budget}). Wrap up now: finish the current step and deliver your final report ` +
    `with the conclusions you already have. At ${budgetStopThreshold(budget)} requests the run is ` +
    `force-stopped and whatever you have is handed back.`
  );
}

/** 强制交出时发给子代理的最后一条提示：不许再调工具，马上交已有结论。 */
export function budgetWrapUpPrompt(): string {
  return (
    '[request budget] This run reached its request limit and was stopped. ' +
    'Do not use any more tools. Reply now with your final report: everything you have already ' +
    'found or concluded, and note anything left unfinished.'
  );
}

/**
 * 一次 Run 的请求计数与阶段。arm() 开始一个预算 Run（重新计数），disarm() 退出预算。
 * observe() 每见到一次模型请求调用一次，返回这一次该做的动作。
 */
export class RequestBudget {
  private count = 0;
  private phase: BudgetPhase = 'idle';
  private noticeSent = false;
  private pendingNotice: string | undefined;

  constructor(readonly soft: number = SOFT_REQUEST_BUDGET) {}

  get requests(): number {
    return this.count;
  }

  get phaseNow(): BudgetPhase {
    return this.phase;
  }

  /** 预算 Run 开始；used 是续跑前已用的请求数，接着累计。soft<=0 视为关闭，保持 idle，不计不拦。 */
  arm(used = 0): void {
    this.count = used;
    this.noticeSent = false;
    this.pendingNotice = undefined;
    this.phase = this.soft > 0 ? 'running' : 'idle';
  }

  /** 非预算回合（主会话、Bot 成员）或 Run 已结束：清零并停止计数。 */
  disarm(): void {
    this.count = 0;
    this.noticeSent = false;
    this.phase = 'idle';
    this.pendingNotice = undefined;
  }

  /** final：这次请求本身就是不带工具调用的最终回答，Run 随之结束，不再打断。 */
  observe(final = false): BudgetAction | undefined {
    if (this.phase === 'idle' || this.phase === 'done') return undefined;
    this.count += 1;
    if (final) return undefined;
    const stop = budgetStopThreshold(this.soft);
    if (this.phase === 'wrapup') {
      if (this.count >= stop + BUDGET_STOP_GRACE_REQUESTS) {
        this.phase = 'done';
        return 'hard';
      }
      return undefined;
    }
    if (this.phase === 'stopping') return undefined;
    if (this.count >= stop) {
      this.phase = 'stopping';
      return 'stop';
    }
    if (!this.noticeSent && this.count >= this.soft) {
      this.noticeSent = true;
      return 'notice';
    }
    return undefined;
  }

  /** 把这次的收尾提示排队，下一次工具结果取走。只在 observe() 返回 notice 时调用。 */
  queueNotice(): void {
    this.pendingNotice = budgetNoticeText(this.count, this.soft);
  }

  /** 取走并清除排队的提示；没有则返回 undefined。重复取只得到一次。 */
  takeNotice(): string | undefined {
    const notice = this.pendingNotice;
    this.pendingNotice = undefined;
    return notice;
  }

  markWrapup(): void {
    if (this.phase === 'stopping') this.phase = 'wrapup';
  }

  markDone(): void {
    this.phase = 'done';
  }
}
