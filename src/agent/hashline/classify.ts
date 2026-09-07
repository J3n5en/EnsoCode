export type EditArgKind =
  | { kind: 'replace' }
  | { kind: 'hashline' }
  | { kind: 'mixed' }
  | { kind: 'invalid' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasHashlineInput(value: Record<string, unknown>): boolean {
  return typeof value.input === 'string' && value.input.length > 0;
}

function hasReplaceFields(value: Record<string, unknown>): boolean {
  if ('edits' in value) return Array.isArray(value.edits);
  return typeof value.oldText === 'string' && typeof value.newText === 'string';
}

function looksLikeBrokenReplace(value: Record<string, unknown>): boolean {
  if ('edits' in value && !Array.isArray(value.edits)) return true;
  const hasOld = typeof value.oldText === 'string';
  const hasNew = typeof value.newText === 'string';
  return hasOld !== hasNew;
}

export function classifyEditArgs(input: unknown): EditArgKind {
  if (!isRecord(input)) return { kind: 'invalid' };
  const hashline = hasHashlineInput(input);
  const replace = hasReplaceFields(input);
  if (hashline && replace) return { kind: 'mixed' };
  if (hashline) return { kind: 'hashline' };
  if (replace) return { kind: 'replace' };
  if (looksLikeBrokenReplace(input) || typeof input.input === 'string') return { kind: 'invalid' };
  return { kind: 'invalid' };
}
