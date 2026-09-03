/** 工作区搜索（mod+k）纯逻辑：文档模型 + 排序/过滤契约，无 electron / fs / React 依赖。 */

export type WorkspaceSearchScope = 'project' | 'all' | 'all-including-archived';

export type WorkspaceSearchFieldKind = 'title' | 'project' | 'id' | 'body' | 'tool';

export interface WorkspaceSearchField {
  field: WorkspaceSearchFieldKind;
  text: string;
}

export interface WorkspaceSearchDoc {
  conversationId: string;
  projectId: string;
  projectName: string;
  title: string;
  lastActiveAt: number;
  archived?: boolean;
  isDraftEmpty?: boolean;
  isCurrent?: boolean;
  parentConversationId?: string;
  coworkerId?: string;
  fields: WorkspaceSearchField[];
}

export interface WorkspaceSearchHit {
  conversationId: string;
  projectId: string;
  title: string;
  field: WorkspaceSearchFieldKind;
  snippet: string;
  nearby?: string[];
  isCurrent?: boolean;
  archived?: boolean;
  parentConversationId?: string;
  coworkerId?: string;
}

export interface WorkspaceSearchOptions {
  /** 当前项目 id：用于 'project' 范围过滤，以及排序时区分「当前项目正文 > 其他项目正文」。 */
  currentProjectId: string;
  scope: WorkspaceSearchScope;
  /** 结果上限，默认 50。 */
  limit?: number;
}

export const WORKSPACE_SEARCH_RESULT_LIMIT = 50;
export const WORKSPACE_SEARCH_SNIPPET_MAX_LENGTH = 160;

const FIELD_PRIORITY: WorkspaceSearchFieldKind[] = ['title', 'project', 'id', 'body', 'tool'];
const TOKEN_RE = /[\p{Letter}\p{Number}]+/gu;
const CJK_RE = /[\u3400-\u9fff]/u;
const SENTENCE_RE = /[^.!?。？！]+[.!?。？！]?/g;

function tokenize(text: string): string[] {
  return text.toLowerCase().match(TOKEN_RE) ?? [];
}

function isCjkToken(token: string): boolean {
  return CJK_RE.test(token);
}

function queryTokens(query: string): string[] {
  return tokenize(query);
}

function fieldMatches(text: string, tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  const lower = text.toLowerCase();
  const textTokens = tokenize(text);
  return tokens.every((token) =>
    isCjkToken(token) ? lower.includes(token) : textTokens.some((part) => part.startsWith(token))
  );
}

function inScope(doc: WorkspaceSearchDoc, options: WorkspaceSearchOptions): boolean {
  if (doc.isDraftEmpty) return false;
  if (options.scope === 'project') {
    return doc.projectId === options.currentProjectId && !doc.archived;
  }
  if (options.scope === 'all') return !doc.archived;
  return true;
}

function firstMatchIndex(text: string, tokens: string[]): number {
  const lower = text.toLowerCase();
  let best = -1;
  for (const token of tokens) {
    if (isCjkToken(token)) {
      const index = lower.indexOf(token);
      if (index >= 0 && (best < 0 || index < best)) best = index;
      continue;
    }
    for (const match of text.matchAll(TOKEN_RE)) {
      if (match[0].toLowerCase().startsWith(token) && match.index !== undefined) {
        if (best < 0 || match.index < best) best = match.index;
        break;
      }
    }
  }
  return best;
}

function snippetOf(text: string, tokens: string[]): string {
  if (text.length <= WORKSPACE_SEARCH_SNIPPET_MAX_LENGTH) return text;
  const index = Math.max(0, firstMatchIndex(text, tokens));
  const start = Math.min(index, Math.max(0, text.length - WORKSPACE_SEARCH_SNIPPET_MAX_LENGTH));
  return text.slice(start, start + WORKSPACE_SEARCH_SNIPPET_MAX_LENGTH);
}

function splitSentences(text: string): string[] {
  return (text.match(SENTENCE_RE) ?? []).map((part) => part.trim()).filter(Boolean);
}

function nearbyOf(text: string, tokens: string[]): string[] | undefined {
  const sentences = splitSentences(text);
  if (sentences.length <= 1) return undefined;
  const index = sentences.findIndex((sentence) => fieldMatches(sentence, tokens));
  if (index < 0) return undefined;
  const nearby = [
    ...[sentences[index - 1], sentences[index - 2]].filter((part): part is string => Boolean(part)),
    ...[sentences[index + 1], sentences[index + 2]].filter((part): part is string => Boolean(part)),
  ];
  return nearby.length > 0 ? nearby : undefined;
}

function matchRank(
  doc: WorkspaceSearchDoc,
  field: WorkspaceSearchFieldKind,
  query: string,
  currentProjectId: string
): number {
  if (doc.title.trim().toLowerCase() === query.trim().toLowerCase()) return 0;
  if (field === 'title') return 1;
  return doc.projectId === currentProjectId ? 2 : 3;
}

function pickField(doc: WorkspaceSearchDoc, tokens: string[]): WorkspaceSearchField | undefined {
  const matched = doc.fields.filter((field) => fieldMatches(field.text, tokens));
  if (matched.length === 0) return undefined;
  return FIELD_PRIORITY.map((kind) => matched.find((field) => field.field === kind)).find(
    (field): field is WorkspaceSearchField => Boolean(field)
  );
}

/**
 * 对本机工作台会话投影做检索排序。
 * 契约见 .trellis/tasks/09-03-workspace-search/design.md。
 */
export function searchWorkspace(
  docs: WorkspaceSearchDoc[],
  query: string,
  options: WorkspaceSearchOptions
): WorkspaceSearchHit[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];

  const limit = options.limit ?? WORKSPACE_SEARCH_RESULT_LIMIT;
  const hits: Array<WorkspaceSearchHit & { rank: number; lastActiveAt: number }> = [];

  for (const doc of docs) {
    if (!inScope(doc, options)) continue;
    const field = pickField(doc, tokens);
    if (!field) continue;
    const nearby = nearbyOf(field.text, tokens);
    hits.push({
      conversationId: doc.conversationId,
      projectId: doc.projectId,
      title: doc.title,
      field: field.field,
      snippet: snippetOf(field.text, tokens),
      ...(nearby ? { nearby } : {}),
      ...(doc.isCurrent ? { isCurrent: true } : {}),
      ...(doc.archived ? { archived: true } : {}),
      ...(doc.parentConversationId ? { parentConversationId: doc.parentConversationId } : {}),
      ...(doc.coworkerId ? { coworkerId: doc.coworkerId } : {}),
      rank: matchRank(doc, field.field, query, options.currentProjectId),
      lastActiveAt: doc.lastActiveAt,
    });
  }

  hits.sort((left, right) => left.rank - right.rank || right.lastActiveAt - left.lastActiveAt);
  return hits.slice(0, limit).map(({ rank: _rank, lastActiveAt: _lastActiveAt, ...hit }) => hit);
}
