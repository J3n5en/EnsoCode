import { APPROVAL_MODES, type ApprovalMode } from '@shared/types/agent';
import { BOT_NAME_MAX, type BotProfile } from '@shared/types/bot';

export type CharacterCardDraft = Pick<BotProfile, 'name' | 'title' | 'scope'> & {
  persona: string;
  color?: string;
  tools?: BotProfile['tools'];
  approvalMode?: ApprovalMode;
  memoryEnabled?: boolean;
};
export type CharacterCardResult =
  | { ok: true; draft: CharacterCardDraft }
  | { ok: false; error: 'invalid-json' | 'not-a-card' };

export function sanitizeBotName(raw: string): string {
  const cleaned = raw
    .normalize('NFC')
    .trim()
    .replace(/\s+/gu, '_')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/_+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  return [...cleaned].slice(0, BOT_NAME_MAX).join('');
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function firstSentence(text: string): string {
  const line = text.split('\n').find((item) => item.trim()) ?? '';
  const match = /^.*?[.!?。！？](?=\s|$)/u.exec(line.trim());
  return (match ? match[0] : line.trim()).slice(0, 80);
}

/** 成员 → SillyTavern V2 卡；enso 专有字段放 extensions.enso（不含技能 / MCP id、模型、委派名单） */
export function buildCharacterCard(
  bot: Pick<
    BotProfile,
    'name' | 'title' | 'scope' | 'avatar' | 'tools' | 'approvalMode' | 'memory'
  >,
  persona: string
) {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: bot.name,
      description: persona,
      personality: '',
      scenario: bot.scope,
      first_mes: '',
      mes_example: '',
      creator_notes: bot.title,
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [] as string[],
      tags: [] as string[],
      creator: 'EnsoCode',
      character_version: '',
      extensions: {
        enso: {
          title: bot.title,
          scope: bot.scope,
          color: bot.avatar.color,
          tools: bot.tools,
          approvalMode: bot.approvalMode,
          memory: bot.memory.enabled,
        },
      },
    },
  };
}

function ensoFields(ext: Record<string, unknown>): Partial<CharacterCardDraft> {
  return {
    ...(typeof ext.title === 'string' ? { title: ext.title.trim() } : {}),
    ...(str(ext.scope) ? { scope: str(ext.scope) } : {}),
    ...(typeof ext.color === 'string' && /^#[0-9a-f]{6}$/iu.test(ext.color)
      ? { color: ext.color }
      : {}),
    ...(ext.tools === 'all' || ext.tools === 'readonly' ? { tools: ext.tools } : {}),
    ...(APPROVAL_MODES.includes(ext.approvalMode as ApprovalMode)
      ? { approvalMode: ext.approvalMode as ApprovalMode }
      : {}),
    ...(typeof ext.memory === 'boolean' ? { memoryEnabled: ext.memory } : {}),
  };
}

/** SillyTavern 人物卡（V2 的 data / V1 顶层字段）→ 成员草稿；只读文本，不碰路径 */
export function parseCharacterCard(text: string): CharacterCardResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'invalid-json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'not-a-card' };
  }
  const root = parsed as Record<string, unknown>;
  const data = isRecord(root.data) ? root.data : root;
  const displayName = str(data.name);
  if (!displayName) return { ok: false, error: 'not-a-card' };
  const enso = isRecord(data.extensions) ? data.extensions.enso : undefined;
  if (isRecord(enso)) {
    const description = typeof data.description === 'string' ? data.description : '';
    return {
      ok: true,
      draft: {
        name: sanitizeBotName(displayName),
        title: '',
        scope: firstSentence(description),
        persona: description,
        ...ensoFields(enso),
      },
    };
  }
  const fill = (value: string) =>
    value.replace(/\{\{char\}\}/giu, displayName).replace(/\{\{user\}\}/giu, 'the user');
  const description = fill(str(data.description));
  const sections = [
    description,
    str(data.personality) && `Personality: ${fill(str(data.personality))}`,
    str(data.scenario) && `Scenario: ${fill(str(data.scenario))}`,
  ].filter(Boolean);
  return {
    ok: true,
    draft: {
      name: sanitizeBotName(displayName),
      title: '',
      scope: firstSentence(description),
      persona: sections.join('\n\n'),
    },
  };
}
