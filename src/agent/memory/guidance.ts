export const MEMORY_SUMMARY_CHAR_BUDGET = 20_000;

const RULES = [
  '# Memory Guidance',
  'Root: memory://root',
  'Rules:',
  '1. Summary below is already loaded. Before working in an area it mentions, read `memory://root/MEMORY.md` for the full section.',
  '2. If needed, inspect `memory://root/skills/<name>/SKILL.md`.',
  '3. Memory: heuristics/process context; current repo files, runtime output, user instruction: factual state/final decisions.',
  '4. Memory changes plan → cite artifact path (e.g. `memory://root/skills/<name>/SKILL.md`) and current-repo evidence.',
  '5. Memory disagreement with repo state/user instruction → stale; corrected behavior, then update/regenerate memory artifacts.',
  '6. Confidence only after repository verification; memory alone NEVER sufficient proof.',
].join('\n');

export function buildMemoryGuidance(input: { summary?: string; learned?: string }): string {
  const summary = input.summary?.trim() ?? '';
  const learned = input.learned?.trim() ?? '';
  const parts = [RULES];
  if (summary) {
    const sliced = summary.slice(0, MEMORY_SUMMARY_CHAR_BUDGET);
    parts.push(`Memory summary:\n${sliced}`);
    if (learned && summary.length <= MEMORY_SUMMARY_CHAR_BUDGET) {
      const remain = MEMORY_SUMMARY_CHAR_BUDGET - sliced.length;
      if (remain > 0)
        parts.push(
          `Learned lessons (\`learn\`-captured; durable but may be stale—verify against repo before relying):\n${learned.slice(0, remain)}`
        );
    }
  } else if (learned) {
    parts.push(
      `Learned lessons (\`learn\`-captured; durable but may be stale—verify against repo before relying):\n${learned.slice(0, MEMORY_SUMMARY_CHAR_BUDGET)}`
    );
  }
  return parts.join('\n');
}
