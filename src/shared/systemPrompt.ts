export const DEFAULT_PERSONA_PROMPT =
  'You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.';

export function replacePersonaParagraph(prompt: string, persona: string): string {
  if (!persona) return prompt;
  if (prompt === DEFAULT_PERSONA_PROMPT || prompt.startsWith(`${DEFAULT_PERSONA_PROMPT}\n\n`)) {
    return `${persona}${prompt.slice(DEFAULT_PERSONA_PROMPT.length)}`;
  }
  return `${prompt}\n\n${persona}`;
}
