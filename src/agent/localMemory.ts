import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { neutralizeInjection, normalizeLearnedText, redactSecrets } from './memory/sanitize';

export const LEARNED_RELATIVE_PATH = path.join('.enso', 'learned.md');
export const LEARNED_FILE_NAME = 'learned.md';
export const MEMORIES_DIR_NAME = 'memories';

/** Project `.enso/learned.md` is no longer injected as agentsFiles. */
export function shouldInjectProjectLearnedFile(): boolean {
  return false;
}

/** Per-turn idle extract into `.enso/learned.md` is off; use `learn` + two-phase. */
export function shouldLearnFromTurn(): boolean {
  return false;
}

export function encodeProjectPath(cwd: string): string {
  return `--${cwd.replace(/^[\\/]/, '').replace(/[\\/:]/g, '-')}--`;
}

export function getMemoryRoot(agentDir: string, cwd: string): string {
  return path.join(agentDir, MEMORIES_DIR_NAME, encodeProjectPath(cwd));
}

const MAX_LEARNED_LESSONS = 100;
const MAX_LEARNED_CONTENT_CHARS = 2000;
const MAX_LEARNED_CONTEXT_CHARS = 400;

export type LearnedLessonInput = { content: string; context?: string };
export type LearnedLessonResult = { stored: 0 | 1; message: string };

const learnedWriteChains = new Map<string, Promise<unknown>>();

export async function saveLearnedLesson(
  agentDir: string,
  cwd: string,
  input: LearnedLessonInput
): Promise<LearnedLessonResult> {
  const content = normalizeLearnedText(input.content, MAX_LEARNED_CONTENT_CHARS);
  if (!content) {
    return { stored: 0, message: 'Empty lesson; nothing stored.' };
  }
  const context = input.context
    ? normalizeLearnedText(input.context, MAX_LEARNED_CONTEXT_CHARS)
    : '';
  const line = context ? `- ${content} _(context: ${context})_` : `- ${content}`;
  const filePath = path.join(getMemoryRoot(agentDir, cwd), LEARNED_FILE_NAME);
  const run = (learnedWriteChains.get(filePath) ?? Promise.resolve()).then(() =>
    appendLearnedLine(filePath, line)
  );
  const guarded = run.catch(() => {});
  learnedWriteChains.set(filePath, guarded);
  try {
    await run;
  } finally {
    if (learnedWriteChains.get(filePath) === guarded) learnedWriteChains.delete(filePath);
  }
  return { stored: 1, message: `Lesson saved to ${LEARNED_FILE_NAME}.` };
}

async function appendLearnedLine(filePath: string, line: string): Promise<void> {
  let existing = '';
  try {
    existing = await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const lines = existing.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const isLesson = (l: string) => l.trimStart().startsWith('- ');
  const out = lines.filter((l) => !(isLesson(l) && l.trim() === line));
  const firstBullet = out.findIndex(isLesson);
  if (firstBullet === -1) out.push(line);
  else out.splice(firstBullet, 0, line);
  let lessonCount = out.filter((l) => isLesson(l)).length;
  for (let i = out.length - 1; i >= 0 && lessonCount > MAX_LEARNED_LESSONS; i--) {
    if (isLesson(out[i] ?? '')) {
      out.splice(i, 1);
      lessonCount--;
    }
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${out.join('\n')}\n`, 'utf8');
}

export async function readLearnedLessons(memoryRoot: string): Promise<string> {
  try {
    const raw = (await readFile(path.join(memoryRoot, LEARNED_FILE_NAME), 'utf8')).trim();
    if (!raw) return '';
    return raw
      .split('\n')
      .map((line) => redactSecrets(neutralizeInjection(line)))
      .join('\n');
  } catch {
    return '';
  }
}
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
