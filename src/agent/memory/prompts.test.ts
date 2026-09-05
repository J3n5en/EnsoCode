import { describe, expect, it } from 'vitest';
import { consolidationUser, STAGE_ONE_SYSTEM } from './prompts';

describe('STAGE_ONE_SYSTEM', () => {
  it('包含与 phase 2 共用的分类法（用户偏好/工作流/架构不变量/坑/未完成线索）', () => {
    expect(STAGE_ONE_SYSTEM).toMatch(/user preference/i);
    expect(STAGE_ONE_SYSTEM).toMatch(/workflow/i);
    expect(STAGE_ONE_SYSTEM).toMatch(/architectural invariant/i);
    expect(STAGE_ONE_SYSTEM).toMatch(/pitfall/i);
    expect(STAGE_ONE_SYSTEM).toMatch(/unfinished/i);
  });

  it('要求写清楚为什么，而不只是做了什么', () => {
    expect(STAGE_ONE_SYSTEM.toLowerCase()).toContain('why');
  });
});

describe('consolidationUser', () => {
  const base = { rawMemories: 'raw', rolloutSummaries: 'summaries' };

  it('包含分类清单、排除清单、长度目标与冲突规则', () => {
    const text = consolidationUser(base);

    expect(text).toMatch(/user preference/i);
    expect(text).toMatch(/workflow/i);
    expect(text).toMatch(/architectural invariant/i);
    expect(text).toMatch(/pitfall/i);
    expect(text).toMatch(/unfinished/i);

    expect(text).toMatch(/single-session/i);
    expect(text.toLowerCase()).toContain('repo-readable');

    expect(text).toMatch(/1500/);
    expect(text).toMatch(/4000/);

    expect(text.toLowerCase()).toContain('newest wins');
    expect(text.toLowerCase()).toContain('superseded');
  });

  it('存在 prior 时输出包含 baseline 合并规则：只修订/追加/过期，不能因为新语料没提就丢弃', () => {
    const text = consolidationUser({
      ...base,
      prior: { memoryMd: 'old fact', summary: 'old summary' },
    });

    expect(text).toContain('old fact');
    expect(text).toContain('old summary');
    expect(text.toLowerCase()).toContain('baseline');
    expect(text.toLowerCase()).toMatch(/revise\/append\/expire|revise, append, expire/);
  });
});
