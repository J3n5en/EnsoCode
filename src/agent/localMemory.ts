import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const LEARNED_RELATIVE_PATH = path.join('.enso', 'learned.md');
export const LOCAL_MEMORY_SYSTEM_PROMPT = [
  'Extract durable project facts from this coding session.',
  'Rules:',
  '- Reply with 3 to 8 short bullet lines.',
  '- Each line starts with "- ".',
  '- Facts only: conventions, paths, decisions, gotchas. No recap of the chat.',
  '- Same language as the session.',
].join('\n');

export function extractLearnedNotes(message: unknown): string[] {
  if (!message || typeof message !== 'object') return [];
  const { content, stopReason } = message as { content?: unknown; stopReason?: unknown };
  if (stopReason === 'error' || stopReason === 'aborted') return [];
  const text = Array.isArray(content)
    ? content
        .map((part) =>
          part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
            ? String((part as { text?: unknown }).text ?? '')
            : ''
        )
        .join('\n')
    : typeof content === 'string'
      ? content
      : '';
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*[-*•]\s+/, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, 8);
}

export function mergeLearnedMarkdown(existing: string, notes: readonly string[]): string {
  const seen = new Set(
    existing
      .split('\n')
      .map((line) =>
        line
          .replace(/^\s*[-*•]\s+/, '')
          .trim()
          .toLowerCase()
      )
      .filter(Boolean)
  );
  const added: string[] = [];
  for (const note of notes) {
    const key = note.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    added.push(`- ${note.trim()}`);
  }
  if (added.length === 0) return existing;
  const body = existing.trim();
  return `${body ? `${body}\n` : ''}${added.join('\n')}\n`;
}

export function readLearnedFile(cwd: string): { path: string; content: string } | undefined {
  const filePath = path.join(cwd, LEARNED_RELATIVE_PATH);
  if (!existsSync(filePath)) return undefined;
  try {
    const content = readFileSync(filePath, 'utf8');
    return content.trim() ? { path: filePath, content } : undefined;
  } catch {
    return undefined;
  }
}

export function appendLearnedFile(cwd: string, notes: readonly string[]): boolean {
  if (notes.length === 0) return false;
  const filePath = path.join(cwd, LEARNED_RELATIVE_PATH);
  let existing = '';
  try {
    existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  } catch {
    existing = '';
  }
  const next = mergeLearnedMarkdown(existing, notes);
  if (next === existing) return false;
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, next, 'utf8');
  return true;
}

export function buildMemoryUserText(messages: Array<{ role?: string; content?: unknown }>): string {
  const chunks: string[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text =
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .map((part) =>
                part && typeof part === 'object' && (part as { type?: string }).type === 'text'
                  ? String((part as { text?: string }).text ?? '')
                  : ''
              )
              .join('')
          : '';
    const trimmed = text.trim();
    if (!trimmed) continue;
    chunks.push(`${message.role}: ${trimmed.slice(0, 800)}`);
  }
  return chunks.slice(-12).join('\n\n').slice(0, 4000);
}
