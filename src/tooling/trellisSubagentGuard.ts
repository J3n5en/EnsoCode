/**
 * Repo-owned Trellis overlay for OMP subagents.
 *
 * `.omp/extensions/trellis/index.ts` is a hashed template. `trellis update`
 * restores it and wipes any inline `if (isSubAgent) return` on
 * `before_agent_start` / `context`. This module is not hashed: the sibling
 * overlay loads it and patches ExtensionRunner so the consent gate is stripped
 * after template restore. `session_start` is intentionally untouched.
 */

export const TRELLIS_WORKFLOW_STATE_TYPE = 'trellis-workflow-state';

export const TRELLIS_SUBAGENT_TYPES = [
  'trellis-implement',
  'trellis-check',
  'trellis-research',
] as const;

export const EXTENSION_RUNNER_SPECIFIERS = [
  '@oh-my-pi/pi-coding-agent',
  '@earendil-works/pi-coding-agent',
] as const;

export const HASHED_OMP_TRELLIS_EXTENSION = '.omp/extensions/trellis/index.ts';
export const OVERLAY_EXTENSION = '.omp/extensions/enso-subagent-guard/index.ts';
export const TEMPLATE_HASHES_PATH = '.trellis/.template-hashes.json';

const TRELLIS_SUBAGENTS = new Set<string>(TRELLIS_SUBAGENT_TYPES);
const INSTALLED = Symbol.for('enso.trellisSubagentConsentGate');
const INLINE_GUARD_RE = /if\s*\(\s*isSubAgent\s*\)\s*return\s*;/;

export type WorkflowStateMessage = {
  customType?: string;
  role?: string;
  content?: unknown;
};

export type BeforeAgentStartResult = {
  messages?: WorkflowStateMessage[];
  systemPrompt?: string;
};

export type ExtensionRunnerLike = {
  prototype: object;
};

export function isTrellisSubAgent(env: NodeJS.ProcessEnv = process.env): boolean {
  const blocked = env.PI_BLOCKED_AGENT;
  return typeof blocked === 'string' && TRELLIS_SUBAGENTS.has(blocked);
}

export function isWorkflowStateMessage(message: unknown): boolean {
  if (message === null || typeof message !== 'object') return false;
  return (message as WorkflowStateMessage).customType === TRELLIS_WORKFLOW_STATE_TYPE;
}

export function stripWorkflowStateMessages<T>(messages: T[]): T[] {
  return messages.filter((message) => !isWorkflowStateMessage(message));
}

export function filterBeforeAgentStartResult(
  result: unknown,
  subAgent = isTrellisSubAgent()
): unknown {
  if (!subAgent || result === null || typeof result !== 'object') return result;
  const record = result as BeforeAgentStartResult;
  if (!Array.isArray(record.messages)) return result;
  const messages = stripWorkflowStateMessages(record.messages);
  return {
    ...record,
    messages: messages.length > 0 ? messages : undefined,
  };
}

export function filterContextResult(result: unknown, subAgent = isTrellisSubAgent()): unknown {
  if (!subAgent || !Array.isArray(result)) return result;
  return stripWorkflowStateMessages(result);
}

export function installExtensionRunnerGuard(Runner: ExtensionRunnerLike): void {
  const proto = Runner.prototype as Record<PropertyKey, unknown>;
  if (proto[INSTALLED]) return;
  proto[INSTALLED] = true;

  const origBefore = proto.emitBeforeAgentStart;
  if (typeof origBefore === 'function') {
    proto.emitBeforeAgentStart = async function (...args: unknown[]) {
      const result = await (origBefore as (...next: unknown[]) => unknown).apply(this, args);
      return filterBeforeAgentStartResult(result, isTrellisSubAgent());
    };
  }

  const origContext = proto.emitContext;
  if (typeof origContext === 'function') {
    proto.emitContext = async function (...args: unknown[]) {
      const result = await (origContext as (...next: unknown[]) => unknown).apply(this, args);
      return filterContextResult(result, isTrellisSubAgent());
    };
  }
}

export function extractHookHandler(source: string, hook: string): string | null {
  const startRe = new RegExp(String.raw`pi\.on\(\s*["']${hook}["']`);
  const startMatch = startRe.exec(source);
  if (!startMatch) return null;
  const brace = source.indexOf('{', startMatch.index);
  if (brace < 0) return null;
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(brace + 1, i);
    }
  }
  return null;
}

export function hookHasInlineSubagentGuard(source: string, hook: string): boolean {
  const body = extractHookHandler(source, hook);
  return body !== null && INLINE_GUARD_RE.test(body);
}

export function hasInlineConsentGateGuards(source: string): boolean {
  return (
    hookHasInlineSubagentGuard(source, 'before_agent_start') &&
    hookHasInlineSubagentGuard(source, 'context')
  );
}

/** Simulate `trellis update` restoring the hashed template (drops the two-line patch). */
export function stripInlineConsentGateGuards(source: string): string {
  let next = source;
  for (const hook of ['before_agent_start', 'context'] as const) {
    const body = extractHookHandler(next, hook);
    if (!body) continue;
    const stripped = body
      .replace(/\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*if\s*\(\s*isSubAgent\s*\)\s*return\s*;\s*/g, '')
      .replace(/if\s*\(\s*isSubAgent\s*\)\s*return\s*;\s*/g, '');
    next = next.replace(body, stripped);
  }
  return next;
}
