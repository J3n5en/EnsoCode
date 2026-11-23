import { describe, expect, it } from 'vitest';
import { todoDispatchPrompt } from './dispatchBrief';

describe('todoDispatchPrompt', () => {
  it('不传 prompt 时直接使用待办原文，不注入推送、合并或验收约束', () => {
    const prompt = todoDispatchPrompt('修看板发送');
    expect(prompt).toBe('修看板发送');
    expect(prompt).not.toMatch(/不推送|不合并|独立目录和空闲端口|不要改主检出/);
  });

  it('传入 prompt 时以 prompt 为准，末尾附带待办原文（背景），不注入默认禁令', () => {
    const brief =
      '修复上游错误恢复并补测试，开 PR，CI 绿后执行 gh pr merge --squash --delete-branch。';
    const prompt = todoDispatchPrompt('上游错误恢复：429 自动退避', brief);
    expect(prompt).toBe(`${brief}\n\n待办原文（背景）：\n上游错误恢复：429 自动退避`);
    expect(prompt.startsWith(brief)).toBe(true);
    expect(prompt).not.toMatch(/不推送|不合并|独立目录和空闲端口|不要改主检出|项目：/);
  });

  it('传入的 prompt 已包含待办原文时不重复附带背景', () => {
    const brief = '上游错误恢复：429 自动退避。\n开 PR 并在 CI 绿后 squash 合并。';
    expect(todoDispatchPrompt('上游错误恢复：429 自动退避', brief)).toBe(brief);
  });

  it('传入空白 prompt 时退回待办原文', () => {
    expect(todoDispatchPrompt('  修看板发送  ', '   ')).toBe('修看板发送');
  });
});
