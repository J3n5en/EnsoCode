import type { DefaultModelRef } from './defaultModel';
import type { ApprovalMode, ThinkingLevel } from './types/agent';
import { APPROVAL_MODES, THINKING_LEVELS } from './types/agentConstants';

export const BTW_SNAPSHOT_LIMIT = 40;
export const BTW_TITLE_MAX_CHARS = 32;
export const BTW_DISABLED_TOOLS = ['subagent', 'coworker', 'workflow', 'plan', 'computer'] as const;

export type BtwMode = 'contextual' | 'tangent';

export type BtwTurn = { role: 'user' | 'assistant'; text: string };

export type BtwSourcePart = { type: string; text?: string };

export type BtwSourceMessage = {
  role: string;
  content: readonly BtwSourcePart[];
};

export type BtwPromptRequest = {
  requestId: string;
  conversationId: string;
  systemPrompt: string;
  userText: string;
  sessionModel?: DefaultModelRef;
  reasoningEnabled?: boolean;
  thinkingLevel?: ThinkingLevel;
};

export type BtwAbortRequest = { requestId: string };

export type BtwSpawnRequest = {
  sessionId: string;
  parentConversationId: string;
  providerId: string;
  modelId: string;
  rolePrompt: string;
  /** 复盘旁路：从该会话分叉消息序列（命中同一份提示缓存）；缺省为纯文本快照旁路 */
  forkFrom?: string;
  reasoningEnabled?: boolean;
  thinkingLevel?: ThinkingLevel;
  approvalMode?: ApprovalMode;
  presetId?: string;
  loadLocalSkills?: boolean;
};

export type BtwDisposeRequest = { sessionId: string };

export type BtwPromptResult =
  | { ok: true; text: string }
  | { ok: false; error: string; aborted?: boolean };

const BTW_ISOLATION =
  'You are a side conversation attached to a coding session. The main agent cannot see this thread. ' +
  'Do not continue the main task unless the user asks you to. Follow the same tool and skill constraints as the main session. ' +
  'Do not spawn subagents, coworkers, or workflows. Answer the user directly.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function asModelRef(value: unknown): DefaultModelRef | null {
  if (!isRecord(value)) return null;
  if (!nonEmptyString(value.providerId) || !nonEmptyString(value.modelId)) return null;
  return { providerId: value.providerId.trim(), modelId: value.modelId.trim() };
}

function messageText(message: BtwSourceMessage): string {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
    .trim();
}

export function snapshotMainConversation(messages: readonly BtwSourceMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = messageText(message);
    if (!text) continue;
    lines.push(`${message.role === 'user' ? 'User' : 'Assistant'}: ${text}`);
  }
  return lines.slice(-BTW_SNAPSHOT_LIMIT).join('\n');
}

export function lastAssistantText(messages: readonly BtwSourceMessage[]): string {
  for (const message of [...messages].reverse()) {
    if (message.role !== 'assistant') continue;
    const text = messageText(message);
    if (text) return text;
  }
  return '';
}

export function btwDisabledTools(existing: readonly string[] = []): string[] {
  const next = [...existing];
  for (const id of BTW_DISABLED_TOOLS) {
    if (!next.includes(id)) next.push(id);
  }
  return next;
}

export function buildBtwSystemPrompt(mode: BtwMode, snapshot: string): string {
  if (mode !== 'contextual') return BTW_ISOLATION;
  const frozen = snapshot.trim();
  if (!frozen) return BTW_ISOLATION;
  return `${BTW_ISOLATION}\n\n# Main conversation (background only)\n${frozen}`;
}

export function isBtwIsolationPrompt(text: string): boolean {
  return text.startsWith(BTW_ISOLATION);
}

export function flattenBtwUserText(history: readonly BtwTurn[], question: string): string {
  const current = question.trim();
  if (history.length === 0) return current;
  const prior = history
    .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`)
    .join('\n');
  return `${prior}\nUser: ${current}`;
}

export function formatBtwHandoff(text: string): string {
  const body = text.trim();
  if (!body) return '';
  return (
    'Treat the following as discussion context from a side conversation, not as work already completed.\n\n' +
    body
  );
}

/**
 * 复盘旁路的角色提示：旁观视角复盘主会话 transcript，产出经用户批准的沉淀。
 * 只写进首条用户消息（rolePrompt），不进系统提示——进了系统提示提示缓存前缀就全废。
 */
export function buildLearnPrompt(): string {
  return [
    '你是一名独立的复盘者，正在审视一段别人（另一个 AI agent）与用户的对话记录。你不是那个犯错的 agent，不要为错误找理由；也不要过度归因——只写对话记录里真实存在的证据。',
    '',
    '# 复盘方法',
    '1. 先扫用户消息里的纠正信号：「不对」「不是」「别」「停」「instead」「that failed」「wrong」等，以及用户反复重述同一要求的地方。每一处纠正都是一次agent走偏的证据。',
    '2. 对比失败路径与最终成功路径的差异点：agent 一开始做了什么、用户纠正后做了什么，差的那一步就是教训所在。',
    '3. 对每个教训判断根因与适用范围：',
    '   - 通用协作习惯或约束（适用于所有项目）→ 全局记忆或全局 skill；',
    '   - 只属于本项目的技术事实、结构约定 → 项目级记忆或项目 skill；',
    '   - 高频、不可违反的硬约束 → AGENTS.md。',
    '4. 负样本出口：如果这段对话没学到任何可复用的东西（用户没纠正过、或纠正只是一次性事实），直接告诉用户「这次没什么可沉淀的」并说明原因，然后结束。不要硬造教训。',
    '',
    '# 澄清与提案',
    '- 证据不足或归因不确定时，用 ask_user 向用户澄清，不要猜。',
    '- 产出提案时逐条给出：类型（memory / skill / AGENTS.md）、落点（全局 / 项目）、理由、精确内容（memory 正文 / skill 文件路径与正文 / AGENTS.md 精确 diff）。',
    '- memory 正文不超过 500 字；skill 是多步流程时才用；AGENTS.md 净增不超过 500 字符且只写硬约束。',
    '- 默认更新已有：已有相关 memory 时用 memory_capture 的 evolvesFrom 演进而不是新建；已有相关 skill 时更新原文件而不是新建。',
    '- 所有落盘动作（memory_capture、写 skill 文件、改 AGENTS.md）必须先经用户明确批准。未批准前只能展示提案。',
    '',
    '# 边界',
    '- 不要继续主会话的任务，不要修改主会话工作区的其他文件。',
    '- 复盘结束后提醒用户可以关闭这个旁路。',
  ].join('\n');
}

/**
 * 复盘旁路的首条用户消息：fork 模式下对话记录就在上文（消息序列分叉续写），
 * 非 fork 降级模式把文本快照贴在消息里。
 */
export function buildLearnFirstMessage(input: { forked: boolean; snapshot: string }): string {
  if (input.forked) {
    const snapshot = input.snapshot.trim();
    const fallback = snapshot
      ? `如果上文没有任何对话记录（分叉未命中），则改用这份文本快照复盘（可能有截断）：\n\n<conversation>\n${snapshot}\n</conversation>`
      : '如果上文也没有任何对话记录，直接告诉用户无法复盘（对话为空），然后结束。';
    return `以上这段对话就是你要复盘的对象。${fallback}。现在开始：先通读，找出用户纠正信号，然后按流程复盘。`;
  }
  const snapshot = input.snapshot.trim();
  if (!snapshot) {
    return '主会话没有可用的对话记录。告诉用户无法复盘（对话为空），然后结束。';
  }
  return [
    '下面是你要复盘的主会话对话记录（文本快照，可能有截断）：',
    '',
    '<conversation>',
    snapshot,
    '</conversation>',
    '',
    '现在开始：先通读，找出用户纠正信号，然后按流程复盘。',
  ].join('\n');
}

export function btwTabTitle(firstQuestion: string): string {
  const line = firstQuestion.trim().split(/\n/, 1)[0]?.trim() ?? '';
  if (line.length <= BTW_TITLE_MAX_CHARS) return line;
  return line.slice(0, BTW_TITLE_MAX_CHARS);
}

export function btwModelCandidates(
  state: Record<string, unknown> | undefined,
  sessionModel?: DefaultModelRef
): DefaultModelRef[] {
  const candidates: DefaultModelRef[] = [];
  for (const ref of [asModelRef(sessionModel), asModelRef(state?.defaultModel)]) {
    if (!ref) continue;
    if (
      candidates.some((item) => item.providerId === ref.providerId && item.modelId === ref.modelId)
    ) {
      continue;
    }
    candidates.push(ref);
  }
  return candidates;
}

export function parseBtwPromptRequest(value: unknown): BtwPromptRequest | null {
  if (!isRecord(value)) return null;
  if (!nonEmptyString(value.requestId) || !nonEmptyString(value.conversationId)) return null;
  if (typeof value.systemPrompt !== 'string' || !nonEmptyString(value.userText)) return null;
  const sessionModel =
    value.sessionModel === undefined ? undefined : asModelRef(value.sessionModel);
  if (value.sessionModel !== undefined && !sessionModel) return null;
  if (value.reasoningEnabled !== undefined && typeof value.reasoningEnabled !== 'boolean') {
    return null;
  }
  if (
    value.thinkingLevel !== undefined &&
    (typeof value.thinkingLevel !== 'string' ||
      !THINKING_LEVELS.includes(value.thinkingLevel as ThinkingLevel))
  ) {
    return null;
  }
  return {
    requestId: value.requestId.trim(),
    conversationId: value.conversationId.trim(),
    systemPrompt: value.systemPrompt,
    userText: value.userText.trim(),
    ...(sessionModel ? { sessionModel } : {}),
    ...(typeof value.reasoningEnabled === 'boolean'
      ? { reasoningEnabled: value.reasoningEnabled }
      : {}),
    ...(typeof value.thinkingLevel === 'string'
      ? { thinkingLevel: value.thinkingLevel as ThinkingLevel }
      : {}),
  };
}

export function parseBtwAbortRequest(value: unknown): BtwAbortRequest | null {
  if (!isRecord(value) || !nonEmptyString(value.requestId)) return null;
  return { requestId: value.requestId.trim() };
}

function parseOptionalReasoning(
  value: Record<string, unknown>
): { reasoningEnabled?: boolean; thinkingLevel?: ThinkingLevel } | null {
  if (value.reasoningEnabled !== undefined && typeof value.reasoningEnabled !== 'boolean') {
    return null;
  }
  if (
    value.thinkingLevel !== undefined &&
    (typeof value.thinkingLevel !== 'string' ||
      !THINKING_LEVELS.includes(value.thinkingLevel as ThinkingLevel))
  ) {
    return null;
  }
  return {
    ...(typeof value.reasoningEnabled === 'boolean'
      ? { reasoningEnabled: value.reasoningEnabled }
      : {}),
    ...(typeof value.thinkingLevel === 'string'
      ? { thinkingLevel: value.thinkingLevel as ThinkingLevel }
      : {}),
  };
}

export function parseBtwSpawnRequest(value: unknown): BtwSpawnRequest | null {
  if (!isRecord(value)) return null;
  if (
    !nonEmptyString(value.sessionId) ||
    !nonEmptyString(value.parentConversationId) ||
    !nonEmptyString(value.providerId) ||
    !nonEmptyString(value.modelId) ||
    typeof value.rolePrompt !== 'string' ||
    !value.rolePrompt.trim()
  ) {
    return null;
  }
  const sessionId = value.sessionId.trim();
  const parentConversationId = value.parentConversationId.trim();
  if (sessionId.includes('::cw-') || sessionId === parentConversationId) return null;
  if (
    value.approvalMode !== undefined &&
    (typeof value.approvalMode !== 'string' ||
      !APPROVAL_MODES.includes(value.approvalMode as ApprovalMode))
  ) {
    return null;
  }
  if (value.presetId !== undefined && typeof value.presetId !== 'string') return null;
  if (value.loadLocalSkills !== undefined && typeof value.loadLocalSkills !== 'boolean') {
    return null;
  }
  if (
    value.forkFrom !== undefined &&
    (typeof value.forkFrom !== 'string' || !value.forkFrom.trim())
  ) {
    return null;
  }
  const reasoning = parseOptionalReasoning(value);
  if (!reasoning) return null;
  return {
    sessionId,
    parentConversationId,
    providerId: value.providerId.trim(),
    modelId: value.modelId.trim(),
    rolePrompt: value.rolePrompt,
    ...(typeof value.forkFrom === 'string' ? { forkFrom: value.forkFrom.trim() } : {}),
    ...reasoning,
    ...(typeof value.approvalMode === 'string'
      ? { approvalMode: value.approvalMode as ApprovalMode }
      : {}),
    ...(typeof value.presetId === 'string' && value.presetId.trim()
      ? { presetId: value.presetId.trim() }
      : {}),
    ...(typeof value.loadLocalSkills === 'boolean'
      ? { loadLocalSkills: value.loadLocalSkills }
      : {}),
  };
}

export function parseBtwDisposeRequest(value: unknown): BtwDisposeRequest | null {
  if (!isRecord(value) || !nonEmptyString(value.sessionId)) return null;
  const sessionId = value.sessionId.trim();
  if (sessionId.includes('::cw-')) return null;
  return { sessionId };
}
