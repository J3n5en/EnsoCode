import { describe, expect, it } from 'vitest';
import {
  BUDGET_STOP_GRACE_REQUESTS,
  budgetNoticeText,
  budgetStopThreshold,
  RequestBudget,
  SOFT_REQUEST_BUDGET,
} from './requestBudget';

const SOFT = 10;
const stopAt = budgetStopThreshold(SOFT);

function drive(budget: RequestBudget, times: number): Array<ReturnType<RequestBudget['observe']>> {
  return Array.from({ length: times }, () => budget.observe());
}

describe('RequestBudget', () => {
  it('默认软预算 200，1.5 倍取整为停止线', () => {
    expect(SOFT_REQUEST_BUDGET).toBe(200);
    expect(budgetStopThreshold()).toBe(300);
    expect(budgetStopThreshold(SOFT)).toBe(15);
  });

  it('未 arm 不计不拦（主会话、Bot 成员不计数）', () => {
    const budget = new RequestBudget(SOFT);
    expect(drive(budget, 100).every((action) => action === undefined)).toBe(true);
    expect(budget.requests).toBe(0);
  });

  it('到软预算只提示一次，提示里带已用次数和上限', () => {
    const budget = new RequestBudget(SOFT);
    budget.arm();
    const before = drive(budget, SOFT - 1);
    expect(before.every((action) => action === undefined)).toBe(true);
    expect(budget.observe()).toBe('notice');
    budget.queueNotice();
    const notice = budget.takeNotice();
    expect(notice).toBe(budgetNoticeText(SOFT, SOFT));
    expect(notice).toContain(`${SOFT}`);
    expect(notice).toContain(`${stopAt}`);
    // 取走后再取为空；继续请求不再提示
    expect(budget.takeNotice()).toBeUndefined();
    const mid = drive(budget, stopAt - SOFT - 1);
    expect(mid.every((action) => action === undefined)).toBe(true);
    expect(budget.takeNotice()).toBeUndefined();
  });

  it('到 1.5 倍返回 stop，之后进入强制交出阶段', () => {
    const budget = new RequestBudget(SOFT);
    budget.arm();
    drive(budget, stopAt - 1);
    expect(budget.observe()).toBe('stop');
    expect(budget.phaseNow).toBe('stopping');
    // 停止线之后、交出之前的请求不再升级
    expect(budget.observe()).toBeUndefined();
    budget.markWrapup();
    expect(budget.phaseNow).toBe('wrapup');
  });

  it('强制交出阶段再给宽限次数，用完返回 hard 并结束', () => {
    const budget = new RequestBudget(SOFT);
    budget.arm();
    drive(budget, stopAt);
    budget.markWrapup();
    const grace = drive(budget, stopAt + BUDGET_STOP_GRACE_REQUESTS - budget.requests - 1);
    expect(grace.every((action) => action === undefined)).toBe(true);
    expect(budget.observe()).toBe('hard');
    expect(budget.phaseNow).toBe('done');
    // 结束后不再计数、不再动作
    expect(budget.observe()).toBeUndefined();
    expect(budget.requests).toBe(stopAt + BUDGET_STOP_GRACE_REQUESTS);
  });

  it('新 Run 重新计数，上一次的提示和阶段不带过来', () => {
    const budget = new RequestBudget(SOFT);
    budget.arm();
    drive(budget, stopAt);
    expect(budget.phaseNow).toBe('stopping');
    budget.arm();
    expect(budget.requests).toBe(0);
    expect(budget.phaseNow).toBe('running');
    expect(budget.observe()).toBeUndefined();
    expect(budget.requests).toBe(1);
  });

  it('soft 为 0 时 arm 也不计数（关闭）', () => {
    const budget = new RequestBudget(0);
    budget.arm();
    expect(budget.phaseNow).toBe('idle');
    expect(drive(budget, 5).every((action) => action === undefined)).toBe(true);
  });

  it('disarm 后停止计数并清零，之后不再提示或中止', () => {
    const budget = new RequestBudget(SOFT);
    budget.arm();
    drive(budget, stopAt);
    expect(budget.phaseNow).toBe('stopping');
    budget.disarm();
    expect(budget.phaseNow).toBe('idle');
    expect(budget.requests).toBe(0);
    expect(drive(budget, stopAt * 2).every((action) => action === undefined)).toBe(true);
    expect(budget.takeNotice()).toBeUndefined();
  });

  it('续跑时 arm 带上已用次数：接着累计，越过软预算的第一次请求就提示', () => {
    const budget = new RequestBudget(SOFT);
    budget.arm(SOFT);
    expect(budget.requests).toBe(SOFT);
    expect(budget.observe()).toBe('notice');
    drive(budget, stopAt - SOFT - 2);
    expect(budget.observe()).toBe('stop');
    budget.arm(stopAt + 10);
    expect(budget.observe()).toBe('stop');
  });

  it('最终回答本身不触发中止或硬停，只计数', () => {
    const budget = new RequestBudget(SOFT);
    budget.arm();
    drive(budget, stopAt - 1);
    expect(budget.observe(true)).toBeUndefined();
    expect(budget.phaseNow).toBe('running');
    expect(budget.requests).toBe(stopAt);
    expect(budget.observe()).toBe('stop');
    budget.markWrapup();
    drive(budget, stopAt + BUDGET_STOP_GRACE_REQUESTS - budget.requests - 1);
    expect(budget.observe(true)).toBeUndefined();
    expect(budget.phaseNow).toBe('wrapup');
  });
});
