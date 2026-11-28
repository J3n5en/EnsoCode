import type { SubagentModelEntry } from '@shared/types';
import { describe, expect, it } from 'vitest';
import {
  buildWizardEntries,
  SUBAGENT_ROLE_PRESETS,
  type SubagentRoleDraft,
} from './subagentModelPresets';

const draft = (overrides: Partial<SubagentRoleDraft> = {}): SubagentRoleDraft => ({
  roleId: 'scout',
  selection: { providerId: 'p', modelId: 'm' },
  description: 'desc',
  ...overrides,
});

const existing: SubagentModelEntry = {
  id: 'old',
  providerId: 'p',
  modelId: 'm',
  description: 'kept',
  enabled: false,
};

function ids() {
  let n = 0;
  return () => `new-${++n}`;
}

describe('SUBAGENT_ROLE_PRESETS', () => {
  it('按固定顺序列出五个角色', () => {
    expect(SUBAGENT_ROLE_PRESETS.map((role) => role.id)).toEqual([
      'scout',
      'worker',
      'reviewer',
      'tester',
      'light',
    ]);
  });
});

describe('buildWizardEntries', () => {
  it('追加模式保留已有条目，跳过未选模型的角色并计数', () => {
    const result = buildWizardEntries(
      [
        draft({ roleId: 'scout', description: '调研', reasoning: 'off' }),
        draft({ roleId: 'worker', selection: null, description: '没选' }),
        draft({ roleId: 'reviewer', description: '评审', reasoning: 'on', thinkingLevel: 'xhigh' }),
      ],
      [existing],
      'append',
      ids()
    );
    expect(result.added).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.entries).toEqual([
      existing,
      { id: 'new-1', providerId: 'p', modelId: 'm', description: '调研', reasoning: 'off' },
      {
        id: 'new-2',
        providerId: 'p',
        modelId: 'm',
        description: '评审',
        reasoning: 'on',
        thinkingLevel: 'xhigh',
      },
    ]);
  });

  it('替换模式丢弃已有条目；全部跳过时替换为空列表', () => {
    expect(buildWizardEntries([draft({ roleId: 'tester' })], [existing], 'replace', ids())).toEqual(
      {
        entries: [{ id: 'new-1', providerId: 'p', modelId: 'm', description: 'desc' }],
        added: 1,
        skipped: 0,
      }
    );
    expect(buildWizardEntries([draft({ selection: null })], [existing], 'replace', ids())).toEqual({
      entries: [],
      added: 0,
      skipped: 1,
    });
    expect(buildWizardEntries([], [existing], 'append', ids())).toEqual({
      entries: [existing],
      added: 0,
      skipped: 0,
    });
  });
});
