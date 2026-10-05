import { BOT_NAME_MAX } from '../types/bot';

/** 目标式新手引导：一句目标 → 推荐单个成员或一个团队模板，并起草第一条消息（只填输入框，不自动发） */

export interface GoalSuggestTemplate {
  id: string;
  title: string;
  summary: string;
}

export interface GoalSuggestInput {
  goal: string;
  language: 'zh' | 'en';
  templates: GoalSuggestTemplate[];
}

export interface GoalSuggestedMember {
  name: string;
  title: string;
  scope: string;
  persona: string;
}

export type GoalSuggestion =
  | { kind: 'member'; member: GoalSuggestedMember; reason: string; firstMessage: string }
  | { kind: 'team'; templateId: string; reason: string; firstMessage: string };

export const GOAL_TEMPLATES_MAX = 30;
const OUT_MAX = { title: 60, scope: 300, persona: 4_000, reason: 300, message: 4_000 } as const;
const GOAL_MAX = 2_000;

const line = (text: string, max = 200) =>
  text.replace(/\s+/g, ' ').trim().slice(0, max).replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function goalSuggestPrompt(input: GoalSuggestInput): {
  systemPrompt: string;
  userText: string;
} {
  const teams = input.templates.length > 0;
  const systemPrompt = [
    'You help a user set up AI teammates in a chat app. Each member is an AI agent with a persona that can use tools; a team is several members in one group chat.',
    teams
      ? 'Given the user goal, recommend exactly one option: ONE member when a single role can handle it, or ONE of the listed team templates only when the goal clearly needs several roles working together.'
      : 'Given the user goal, recommend ONE member that fits it.',
    'Reply with one JSON object only:',
    '{"kind": "member", "member": {"name": "...", "title": "...", "scope": "...", "persona": "..."}, "reason": "...", "firstMessage": "..."}',
    ...(teams
      ? [
          'or {"kind": "team", "templateId": "<one listed id>", "reason": "...", "firstMessage": "..."}',
        ]
      : []),
    `- name: a short human-like first name, letters or digits only, no spaces, at most ${BOT_NAME_MAX} characters.`,
    '- title: a short role. scope: one sentence of responsibilities. persona: second person ("You are ..."), concise Markdown, 80-180 words; do not invent tools, credentials or real people.',
    '- reason: one short sentence explaining the choice.',
    '- firstMessage: the first message the user will send, written as the user, concrete and based only on the goal; do not invent facts.',
    `Write all text in ${input.language === 'zh' ? 'Simplified Chinese' : 'English'}.`,
  ].join('\n');
  const userText = [
    `<goal>${line(input.goal, GOAL_MAX)}</goal>`,
    ...(teams
      ? [
          '<templates>',
          ...input.templates.map((t) => `${line(t.id, 60)}: ${line(t.title)} — ${line(t.summary)}`),
          '</templates>',
        ]
      : []),
  ].join('\n');
  return { systemPrompt, userText };
}

const str = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

function memberName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const cleaned = value.normalize('NFC').replace(/[^\p{L}\p{N}_-]/gu, '');
  return [...cleaned].slice(0, BOT_NAME_MAX).join('');
}

export function parseGoalSuggestion(
  text: string,
  input: Pick<GoalSuggestInput, 'goal' | 'templates'>
): GoalSuggestion | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const reason = str(v.reason, OUT_MAX.reason);
  const firstMessage = str(v.firstMessage, OUT_MAX.message) || input.goal.trim();
  if (v.kind === 'team') {
    const templateId = input.templates.find((t) => t.id === v.templateId)?.id;
    return templateId ? { kind: 'team', templateId, reason, firstMessage } : null;
  }
  if (v.kind !== 'member' || !v.member || typeof v.member !== 'object') return null;
  const m = v.member as Record<string, unknown>;
  const name = memberName(m.name);
  const title = str(m.title, OUT_MAX.title);
  if (!name || !title) return null;
  return {
    kind: 'member',
    member: {
      name,
      title,
      scope: str(m.scope, OUT_MAX.scope),
      persona: str(m.persona, OUT_MAX.persona),
    },
    reason,
    firstMessage,
  };
}
