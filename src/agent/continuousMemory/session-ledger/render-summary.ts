import { CARRIED_BOUNDARY_ID, type Observation, type Reflection } from './types.js';

const CONTEXT_USAGE_INSTRUCTIONS = `These are condensed memories from earlier in this session.

- Reflections: stable, long-lived facts about the user, project, decisions, and constraints. New reflection lines may include ids in brackets.
- Observations: timestamped events from the conversation history, in chronological order. Observation lines include ids in brackets. A "[carried boundary]" line marks earlier lower-priority details that were compacted away; it has no id and cannot be recalled.

Treat these as past records. When entries conflict, the most recent observation reflects the latest known state. Work that prior observations describe as completed should not be redone unless the user explicitly asks to revisit it.

When exact source context is needed for precision or traceability, use the recall tool with the relevant observation or reflection id. This is especially useful when a reflection materially affects a decision or is too compressed to continue confidently. Do not use recall as broad search or inject raw source unless it is needed.`;

export function observationToSummaryLine(observation: Observation): string {
  if (observation.id === CARRIED_BOUNDARY_ID) return `[carried boundary] ${observation.content}`;
  return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`;
}

export function reflectionToSummaryLine(reflection: Reflection): string {
  return `[${reflection.id}] ${reflection.content}`;
}

export function renderSummary(reflections: Reflection[], observations: Observation[]): string {
  if (reflections.length === 0 && observations.length === 0) return '';

  const parts: string[] = [CONTEXT_USAGE_INSTRUCTIONS];
  if (reflections.length > 0) {
    parts.push(`## Reflections\n${reflections.map(reflectionToSummaryLine).join('\n')}`);
  }
  if (observations.length > 0) {
    parts.push(`## Observations\n${observations.map(observationToSummaryLine).join('\n')}`);
  }
  return parts.join('\n\n');
}
