import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { StageOneCandidate } from './stageOne';

export type PersistableMemoryMessage = {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'toolResult';
  text: string;
  toolName?: string;
};

export function classifySessionFile(name: string): StageOneCandidate['sourceKind'] {
  if (name.includes('__cw-')) return 'coworker';
  if (name.startsWith('enso-')) return 'child';
  return 'parent';
}

function parseHeader(text: string): { id?: string; cwd?: string } {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.type === 'title') continue;
      if (entry.type === 'session') {
        return {
          ...(typeof entry.id === 'string' ? { id: entry.id } : {}),
          ...(typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {}),
        };
      }
      break;
    } catch {}
  }
  return {};
}

function sameCwd(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

export async function listMemoryThreads(
  sessionDir: string,
  opts: { cwd: string }
): Promise<StageOneCandidate[]> {
  let names: string[];
  try {
    names = await readdir(sessionDir);
  } catch {
    return [];
  }
  const out: StageOneCandidate[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const sessionFile = path.join(sessionDir, name);
    let updatedAtSec: number;
    try {
      updatedAtSec = Math.floor((await stat(sessionFile)).mtimeMs / 1000);
    } catch {
      continue;
    }
    let text = '';
    try {
      text = await readFile(sessionFile, 'utf8');
    } catch {
      continue;
    }
    const header = parseHeader(text);
    if (!header.cwd || !sameCwd(header.cwd, opts.cwd)) continue;
    out.push({
      threadId: header.id ?? name.slice(0, -'.jsonl'.length),
      sessionFile,
      cwd: header.cwd,
      updatedAtSec,
      sourceKind: classifySessionFile(name),
    });
  }
  return out;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && typeof part === 'object' && part.type === 'text')
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('\n')
    .trim();
}

export function extractPersistableMessages(payload: string): PersistableMemoryMessage[] {
  const out: PersistableMemoryMessage[] = [];
  for (const raw of payload.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type !== 'message' || !entry.message || typeof entry.message !== 'object') continue;
    const message = entry.message as Record<string, unknown>;
    const role = message.role;
    if (role === 'system' || role === 'developer' || role === 'user' || role === 'assistant') {
      const text = textFromContent(message.content);
      if (!text) continue;
      out.push({ role, text });
      continue;
    }
    if (role !== 'toolResult') continue;
    const text = textFromContent(message.content);
    const toolName = typeof message.toolName === 'string' ? message.toolName : undefined;
    if (
      !toolName ||
      !['bash', 'eval', 'read', 'grep'].includes(toolName) ||
      !text ||
      text.length > 32_000
    ) {
      continue;
    }
    out.push({ role, text, toolName });
  }
  return out;
}
