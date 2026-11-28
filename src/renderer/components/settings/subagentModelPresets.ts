import type {
  ModelReasoningOverride,
  ModelThinkingLevelOverride,
  SubagentModelEntry,
} from '@shared/types';

export type SubagentRoleId = 'scout' | 'worker' | 'reviewer' | 'tester' | 'light';

/** 文案字段都是 t() key */
export interface SubagentRolePreset {
  readonly id: SubagentRoleId;
  readonly title: string;
  readonly summary: string;
  readonly chip: string;
  readonly template: string;
}

export const SUBAGENT_ROLE_PRESETS: readonly SubagentRolePreset[] = [
  {
    id: 'scout',
    title: 'Scout · Research',
    summary: 'Read code, search docs, summarize findings.',
    chip: 'scout research',
    template:
      'Use for lookups and read-only exploration: reading code, searching the repo, checking docs, and summarizing findings. Fast and cheap; do not use it for architecture decisions.',
  },
  {
    id: 'worker',
    title: 'Worker · Implementation',
    summary: 'Main coding, bug fixes, scoped subtasks.',
    chip: 'worker build',
    template:
      'Use for the main coding work: implementing features, fixing bugs, and self-contained coding subtasks with a clear scope.',
  },
  {
    id: 'reviewer',
    title: 'Reviewer · Deep review & architecture',
    summary: 'Code review, architecture, hard debugging.',
    chip: 'reviewer review',
    template:
      'Use for code review, architecture trade-offs, and hard debugging. Strongest reasoning but slower and pricier; do not use it for bulk scanning.',
  },
  {
    id: 'tester',
    title: 'Tester · Tests',
    summary: 'Failing tests first (TDD), unit coverage.',
    chip: 'tester tests',
    template:
      'Use for writing tests: failing tests first for TDD, and adding unit test coverage to existing code.',
  },
  {
    id: 'light',
    title: 'Light · Mechanical edits & fallback',
    summary: 'Bulk mechanical edits, formatting, errands.',
    chip: 'light errands',
    template:
      'Use for bulk mechanical replacements, formatting, and high-throughput errands, or as a fallback for exploration. Cheapest; not for tasks that need judgment.',
  },
];

export interface SubagentRoleDraft {
  roleId: SubagentRoleId;
  /** null = 跳过此角色 */
  selection: { providerId: string; modelId: string } | null;
  description: string;
  reasoning?: ModelReasoningOverride;
  thinkingLevel?: ModelThinkingLevelOverride;
}

export type SubagentWizardMode = 'append' | 'replace';

export function buildWizardEntries(
  drafts: readonly SubagentRoleDraft[],
  existing: readonly SubagentModelEntry[],
  mode: SubagentWizardMode,
  newId: () => string
): { entries: SubagentModelEntry[]; added: number; skipped: number } {
  const created: SubagentModelEntry[] = [];
  for (const draft of drafts) {
    if (!draft.selection) continue;
    created.push({
      id: newId(),
      ...draft.selection,
      description: draft.description,
      ...(draft.reasoning ? { reasoning: draft.reasoning } : {}),
      ...(draft.thinkingLevel ? { thinkingLevel: draft.thinkingLevel } : {}),
    });
  }
  return {
    entries: mode === 'replace' ? created : [...existing, ...created],
    added: created.length,
    skipped: drafts.length - created.length,
  };
}
