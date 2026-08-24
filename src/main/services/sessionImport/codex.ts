import fs from 'node:fs';
import path from 'node:path';
import type { ExternalSession, SimpleMessage } from '@shared/types/sessionImport';

/** 扫描的会话文件数量上限（按 mtime 取最近的） */
const MAX_FILES = 2000;

const parseLine = (line: string): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
};

function listRolloutFiles(sessionsDir: string): { path: string; mtime: number }[] {
  const results: { path: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || results.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        try {
          results.push({ path: full, mtime: fs.statSync(full).mtimeMs });
        } catch {}
      }
    }
  };
  walk(sessionsDir, 0);
  return results.sort((a, b) => b.mtime - a.mtime);
}

/** 只读首行 session_meta 判定该会话属于哪个目录 */
function cwdOfSession(filePath: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(4096);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const firstLine = buffer.toString('utf-8', 0, bytes).split('\n', 1)[0];
    const entry = parseLine(firstLine);
    const payload = entry?.payload as { cwd?: unknown } | undefined;
    return typeof payload?.cwd === 'string' ? payload.cwd : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function textOfParts(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const p = part as { type?: string; text?: unknown };
      return p.type === 'input_text' || p.type === 'output_text' ? String(p.text ?? '') : '';
    })
    .join('');
}

/** 解析单个 Codex rollout 文件为拉平消息 */
export function readCodexSession(filePath: string): { title: string; messages: SimpleMessage[] } {
  const messages: SimpleMessage[] = [];
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return { title: '', messages: [] };
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    const entry = parseLine(line);
    if (entry?.type !== 'response_item') continue;
    const payload = entry.payload as
      | { type?: string; role?: string; content?: unknown }
      | undefined;
    if (payload?.type !== 'message' || (payload.role !== 'user' && payload.role !== 'assistant'))
      continue;
    const text = textOfParts(payload.content).trim();
    if (!text) continue;
    // Codex 把系统指令等包装成 user message；<user_instructions>/<environment_context> 类噪声跳过
    if (payload.role === 'user' && /^</.test(text)) continue;
    const timestamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : undefined;
    messages.push({ role: payload.role, text, timestamp });
  }
  const title = messages.find((m) => m.role === 'user')?.text.slice(0, 40) ?? '';
  return { title, messages };
}

/** 列出 Codex 在某项目目录下的会话 */
export function listCodexSessions(
  projectPath: string,
  home = process.env.HOME ?? ''
): ExternalSession[] {
  const files = listRolloutFiles(path.join(home, '.codex', 'sessions'));
  const sessions: ExternalSession[] = [];
  for (const file of files) {
    if (cwdOfSession(file.path) !== projectPath) continue;
    const { title, messages } = readCodexSession(file.path);
    if (messages.length === 0) continue;
    sessions.push({ path: file.path, title, updatedAt: file.mtime, messageCount: messages.length });
  }
  return sessions;
}
