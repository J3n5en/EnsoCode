/** Shared taxonomy for stage 1 extraction and phase 2 consolidation — must not drift apart. */
const TAXONOMY = [
  '1. User preferences & communication habits',
  '2. Workflow & commit conventions',
  '3. Architectural invariants & "don\'t redo this"',
  '4. Pitfalls + why (root cause, not just the symptom)',
  '5. Unfinished threads / open leads',
].join('\n');

const EXCLUSIONS = [
  '- Single-session episodes: "user wanted X this time", one-off rejections/approvals, anything that only',
  '  mattered for one rollout and has no bearing on future ones.',
  '- Repo-readable code facts: anything a future agent can just read from the current repository — unless it',
  '  is a previously-missed lesson (e.g. "grep here first, this file looks unrelated but isn\'t").',
].join('\n');

const CONFLICT_RULE =
  'Conflict rule: newest wins — when a new artifact contradicts existing memory, the newest evidence wins; ' +
  'mark the superseded claim as superseded in memory_md instead of silently deleting it.';

export const STAGE_ONE_SYSTEM = [
  'Memory-stage-one extractor.',
  '',
  'MUST return strict JSON only; no markdown, no commentary.',
  '',
  'MUST distill reusable, durable rollout knowledge, classified by:',
  TAXONOMY,
  '',
  EXCLUSIONS,
  '',
  '- Explain WHY, not just what: a pitfall without its root cause is not durable signal.',
  '- NEVER include transient chatter or low-signal noise.',
  '',
  'Required JSON:',
  '{',
  '  "rollout_summary": "string",',
  '  "rollout_slug": "string | null",',
  '  "raw_memory": "string"',
  '}',
  '',
  '- rollout_summary: compact synopsis future runs should remember.',
  '- rollout_slug: short lowercase slug (letters/numbers/_), or null.',
  '- raw_memory: detailed durable-memory blocks, tagged by taxonomy category; enough context to reuse.',
  '- No durable signal ⇒ MUST return empty strings for rollout_summary/raw_memory and null rollout_slug.',
].join('\n');

export function stageOneUser(threadId: string, itemsJson: string): string {
  return [
    `thread_id: ${threadId}`,
    '',
    'Persistable response items (JSON):',
    itemsJson,
    '',
    'You MUST extract durable memory now.',
  ].join('\n');
}

export const CONSOLIDATION_SYSTEM = [
  'You are the memory-stage-two consolidator.',
  '',
  'Follow the user-provided consolidation task exactly.',
  'Return strict JSON only — no markdown, no commentary.',
].join('\n');

export function consolidationUser(input: {
  prior?: { memoryMd: string; summary: string };
  rawMemories: string;
  rolloutSummaries: string;
}): string {
  const parts = ['Memory consolidation agent.', 'Memory root: memory://root'];
  if (input.prior) {
    parts.push(
      'Prior memory is the baseline: revise, append, expire — never drop an entry just',
      'because the new artifacts below are silent about it.',
      '## Prior MEMORY.md',
      input.prior.memoryMd,
      '## Prior memory_summary.md',
      input.prior.summary
    );
  }
  parts.push(
    'Input corpus (raw memories):',
    input.rawMemories,
    'Input corpus (rollout summaries):',
    input.rolloutSummaries,
    '',
    'Classify every durable item into this taxonomy (shared with stage 1):',
    TAXONOMY,
    '',
    'Exclude:',
    EXCLUSIONS,
    '',
    CONFLICT_RULE,
    '',
    'Produce strict JSON only with this schema — you NEVER include any other output:',
    '{',
    '  "memory_md": "string",',
    '  "memory_summary": "string",',
    '  "skills": [{ "name": "string", "content": "string" }]',
    '}',
    'Requirements:',
    '- memory_md: long-term memory document, structured Markdown sectioned by taxonomy, headings per',
    '  category, keep file:line / commit anchors, mark superseded claims explicitly.',
    '- memory_summary: prompt-time memory guidance, sectioned by taxonomy, target 1500–4000 chars total;',
    '  within each section, lead with the item most likely to change next-session behavior.',
    '- skills: reusable playbooks. Empty array allowed.',
    '- Treat memory as advisory: current repository state wins.'
  );
  return parts.join('\n');
}
