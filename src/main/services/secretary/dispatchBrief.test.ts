import { describe, expect, it } from 'vitest';
import { hasDispatchBrief, todoDispatchPrompt } from './dispatchBrief';

const facts = {
  projectPath: '/repo/alpha',
  branch: 'feat/secretary-agent',
  worktree: true,
};

describe('todoDispatchPrompt', () => {
  it('只有标题时补上项目、当前分支、worktree、不推送和验收隔离', () => {
    const prompt = todoDispatchPrompt('修看板发送', undefined, facts);
    expect(prompt).toContain('项目：/repo/alpha');
    expect(prompt).toContain('基于 feat/secretary-agent 新建分支');
    expect(prompt).toContain('独立 worktree');
    expect(prompt).toContain('不推送，也不合并。');
    expect(prompt).toContain('独立目录和空闲端口');
    expect(prompt.endsWith('修看板发送')).toBe(true);
    expect(prompt).not.toBe('修看板发送');
  });

  it('秘书已经写了完整说明时原样使用，不重复套模板', () => {
    const brief =
      '基于 feat/secretary-agent 新建分支，在独立 worktree 里工作，不推送不合并。\n修通知';
    expect(hasDispatchBrief(brief)).toBe(true);
    expect(todoDispatchPrompt('修通知', brief, facts)).toBe(brief);
  });

  it('没有分支名时不编一个分支', () => {
    const prompt = todoDispatchPrompt('修看板发送', undefined, { ...facts, branch: null });
    expect(prompt).toContain('基于当前检出新建分支');
    expect(prompt).not.toContain('feat/secretary-agent');
  });

  it('这次不建 worktree 时不说已经隔离', () => {
    const prompt = todoDispatchPrompt('修看板发送', undefined, { ...facts, worktree: false });
    expect(prompt).not.toContain('已建好的独立 worktree');
    expect(prompt).toContain('当前分支是 feat/secretary-agent');
    expect(prompt).toContain('不推送，也不合并。');
  });
});
