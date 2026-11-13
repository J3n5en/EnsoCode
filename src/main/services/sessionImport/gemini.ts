import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ExternalSession, SimpleMessage } from '@shared/types/sessionImport';

const parseLine = (line: string): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/**
 * 上游 content 是 @google/genai 的 PartListUnion：字符串、单个 Part 或数组，Part 形如 {text}、没有 type 字段；
 * thought 为 true 的是思考摘要而非回复。带 type 时只认 'text'，兼容旧的仿 Anthropic 形状。
 */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  const parts = Array.isArray(content)
    ? content
    : content && typeof content === 'object'
      ? [content]
      : [];
  return parts
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      const p = part as { type?: unknown; text?: unknown; thought?: unknown };
      if (p.thought === true || (p.type !== undefined && p.type !== 'text')) return '';
      return typeof p.text === 'string' ? p.text : '';
    })
    .join('');
}

function messagesFromEntries(entries: unknown[]): SimpleMessage[] {
  const messages: SimpleMessage[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    // 上游模型消息的 type 是 'gemini'；'assistant' 保留给旧格式
    const role =
      entry.type === 'user'
        ? 'user'
        : entry.type === 'gemini' || entry.type === 'assistant'
          ? 'assistant'
          : null;
    if (!role) continue;
    const text = textOfContent(entry.content).trim();
    if (!text) continue;
    messages.push({ role, text });
  }
  return messages;
}

/** 上游压缩、中断占位等改写历史时写的 $patch：先改正文，再删除，最后把 orderIds 依次挪到末尾 */
function applyPatch(
  byId: Map<string | symbol, Record<string, unknown>>,
  patch: Record<string, unknown>
): void {
  const updates = [patch, ...(Array.isArray(patch.updates) ? patch.updates : [])];
  for (const update of updates) {
    if (!update || typeof update !== 'object') continue;
    const { id, content } = update as { id?: unknown; content?: unknown };
    const existing = typeof id === 'string' ? byId.get(id) : undefined;
    if (typeof id === 'string' && existing && content !== undefined) {
      byId.set(id, { ...existing, content });
    }
  }
  for (const id of Array.isArray(patch.removeIds) ? patch.removeIds : []) {
    if (typeof id === 'string') byId.delete(id);
  }
  // 未列出的条目保持原顺序在前，列出的按 orderIds 顺序接在后面，与上游一致
  for (const id of Array.isArray(patch.orderIds) ? patch.orderIds : []) {
    const message = typeof id === 'string' ? byId.get(id) : undefined;
    if (typeof id !== 'string' || !message) continue;
    byId.delete(id);
    byId.set(id, message);
  }
}

/**
 * 按上游 chatRecordingService 的读法重放 jsonl：消息更新时会按同一 id 整条再追加，
 * 以最后一版为准且保留首次出现的位置（Map 覆盖不改顺序）。没有 id 的旧格式消息按出现顺序保留。
 */
function replayJsonl(records: Record<string, unknown>[]): unknown[] {
  const byId = new Map<string | symbol, Record<string, unknown>>();
  for (const record of records) {
    if (typeof record.$rewindTo === 'string') {
      // /rewind 与中断回滚：目标及之后全部作废；目标不在表里时上游清空全部，保持一致
      const keys = [...byId.keys()];
      const index = keys.indexOf(record.$rewindTo);
      for (const key of index === -1 ? keys : keys.slice(index)) byId.delete(key);
    } else if (record.$patch && typeof record.$patch === 'object') {
      applyPatch(byId, record.$patch as Record<string, unknown>);
    } else if (typeof record.id === 'string') {
      byId.set(record.id, record);
    } else if (record.$set && typeof record.$set === 'object') {
      // 其余 $set 只是元数据；旧版的 messages 是整段检查点，替换此前全部消息
      const checkpoint = (record.$set as { messages?: unknown }).messages;
      if (!Array.isArray(checkpoint)) continue;
      byId.clear();
      for (const raw of checkpoint) {
        const message = raw as Record<string, unknown> | null;
        if (message && typeof message === 'object' && typeof message.id === 'string') {
          byId.set(message.id, message);
        }
      }
    } else if (typeof record.type === 'string') {
      byId.set(Symbol(), record);
    }
  }
  return [...byId.values()];
}

function isWholeJson(filePath: string, content: string): Record<string, unknown> | null {
  if (filePath.endsWith('.jsonl')) return null;
  const obj = parseLine(content.trim());
  if (!obj) return null;
  if (
    Array.isArray(obj.messages) ||
    typeof obj.kind === 'string' ||
    typeof obj.sessionId === 'string'
  ) {
    return obj;
  }
  return null;
}

function kindOf(filePath: string, content: string): string {
  const whole = isWholeJson(filePath, content);
  if (typeof whole?.kind === 'string') return whole.kind;
  for (const line of content.split('\n')) {
    const entry = parseLine(line);
    if (typeof entry?.kind === 'string') return entry.kind;
  }
  return '';
}

/** 解析 Gemini CLI session 文件（jsonl 或整文件 JSON） */
export function readGeminiSession(filePath: string): { title: string; messages: SimpleMessage[] } {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return { title: '', messages: [] };
  }
  const whole = isWholeJson(filePath, content);
  let firstUserMessage = '';
  let messages: SimpleMessage[] = [];
  if (whole) {
    if (typeof whole.firstUserMessage === 'string') firstUserMessage = whole.firstUserMessage;
    messages = messagesFromEntries(Array.isArray(whole.messages) ? whole.messages : []);
  } else {
    const entries: Record<string, unknown>[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const entry = parseLine(line);
      if (entry) entries.push(entry);
    }
    messages = messagesFromEntries(replayJsonl(entries));
  }
  const title =
    firstUserMessage || messages.find((m) => m.role === 'user')?.text.slice(0, 40) || '';
  return { title, messages };
}

function projectSlug(home: string, projectPath: string): string | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(home, '.gemini', 'projects.json'), 'utf-8')
    ) as {
      projects?: Record<string, unknown>;
    };
    const slug = raw.projects?.[projectPath];
    return typeof slug === 'string' && slug ? slug : null;
  } catch {
    return null;
  }
}

function listSessionFiles(home: string, identifier: string): string[] {
  const dir = path.join(home, '.gemini', 'tmp', identifier, 'chats');
  try {
    return fs
      .readdirSync(dir)
      .filter(
        (name) => name.startsWith('session-') && (name.endsWith('.jsonl') || name.endsWith('.json'))
      )
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

function isSubagent(filePath: string): boolean {
  try {
    return kindOf(filePath, fs.readFileSync(filePath, 'utf-8')) === 'subagent';
  } catch {
    return false;
  }
}

/** 列出 Gemini CLI 在某项目下的会话（同时认 slug 与 sha256） */
export function listGeminiSessions(
  projectPath: string,
  home = process.env.HOME ?? ''
): ExternalSession[] {
  const ids = new Set<string>();
  const slug = projectSlug(home, projectPath);
  if (slug) ids.add(slug);
  ids.add(createHash('sha256').update(projectPath).digest('hex'));
  const seen = new Set<string>();
  const sessions: ExternalSession[] = [];
  for (const id of ids) {
    for (const filePath of listSessionFiles(home, id)) {
      if (seen.has(filePath) || isSubagent(filePath)) continue;
      seen.add(filePath);
      const { title, messages } = readGeminiSession(filePath);
      if (messages.length === 0) continue;
      let updatedAt = 0;
      try {
        updatedAt = fs.statSync(filePath).mtimeMs;
      } catch {}
      sessions.push({ path: filePath, title, updatedAt, messageCount: messages.length });
    }
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}
