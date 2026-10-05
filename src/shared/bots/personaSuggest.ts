/** 「AI 生成人设」：按名称与角色写人设，职责空着时顺带补上；结果只填进表单，仍需用户保存 / 创建 */

export interface PersonaSuggestInput {
  name: string;
  title: string;
  scope: string;
  persona: string;
  language: 'zh' | 'en';
}

export interface PersonaSuggestion {
  persona: string;
  scope?: string;
}

const PERSONA_OUT_MAX = 4_000;
const SCOPE_OUT_MAX = 300;
const IN_MAX = 2_000;

const line = (text: string, max = 200) =>
  text.replace(/\s+/g, ' ').trim().slice(0, max).replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function personaSuggestPrompt(input: PersonaSuggestInput): {
  systemPrompt: string;
  userText: string;
} {
  const wantScope = !input.scope.trim();
  const systemPrompt = [
    'You write the persona of an AI team member. The persona becomes part of its system prompt.',
    'Write it in the second person ("You are ..."), as concise Markdown: who it is, personality and tone, how it works and collaborates with teammates, what it cares about, and what it avoids. About 120-250 words.',
    'Stay faithful to the given name and role; do not invent tools, credentials or real people. Keep it practical rather than theatrical.',
    'If an existing persona is given, keep its intent and improve it.',
    wantScope
      ? 'Reply with one JSON object only: {"persona": "...", "scope": "..."}; scope is one short sentence listing the responsibilities, used to route group messages and delegations.'
      : 'Reply with one JSON object only: {"persona": "..."}.',
    `Write in ${input.language === 'zh' ? 'Simplified Chinese' : 'English'}.`,
  ].join('\n');
  const userText = [
    '<member>',
    `name: ${line(input.name)}`,
    `role: ${line(input.title)}`,
    ...(wantScope ? [] : [`responsibilities: ${line(input.scope, IN_MAX)}`]),
    ...(input.persona.trim() ? [`existing persona: ${line(input.persona, IN_MAX)}`] : []),
    '</member>',
  ].join('\n');
  return { systemPrompt, userText };
}

export function parsePersonaSuggestion(
  text: string,
  input: Pick<PersonaSuggestInput, 'scope'>
): PersonaSuggestion | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const { persona, scope } = value as Record<string, unknown>;
  if (typeof persona !== 'string' || !persona.trim()) return null;
  const result: PersonaSuggestion = { persona: persona.trim().slice(0, PERSONA_OUT_MAX) };
  if (!input.scope.trim() && typeof scope === 'string' && scope.trim())
    result.scope = scope.trim().slice(0, SCOPE_OUT_MAX);
  return result;
}
