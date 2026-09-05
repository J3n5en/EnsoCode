export const STAGE_ONE_SYSTEM = [
  'Memory-stage-one extractor.',
  '',
  'MUST return strict JSON only; no markdown, no commentary.',
  '',
  'MUST distill reusable, durable rollout knowledge:',
  '- Keep concrete technical signal: constraints, decisions, workflows, pitfalls, resolved failures.',
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
  '- raw_memory: detailed durable-memory blocks; enough context to reuse.',
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

export function consolidationUser(rawMemories: string, rolloutSummaries: string): string {
  return [
    'Memory consolidation agent.',
    'Memory root: memory://root',
    'Input corpus (raw memories):',
    rawMemories,
    'Input corpus (rollout summaries):',
    rolloutSummaries,
    'Produce strict JSON only with this schema — you NEVER include any other output:',
    '{',
    '  "memory_md": "string",',
    '  "memory_summary": "string",',
    '  "skills": [{ "name": "string", "content": "string" }]',
    '}',
    'Requirements:',
    '- memory_md: long-term memory document.',
    '- memory_summary: prompt-time memory guidance.',
    '- skills: reusable playbooks. Empty array allowed.',
    '- Treat memory as advisory: current repository state wins.',
  ].join('\n');
}
