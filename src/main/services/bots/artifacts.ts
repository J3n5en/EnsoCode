import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ProjectedMessage } from '@shared/types/agent';
import { isBotId } from '@shared/types/bot';
import type { BotArtifact, BotArtifactKind, BotArtifactTarget } from '@shared/types/botIpc';

/** 每条消息最多展示的产物卡片数 */
export const BOT_ARTIFACT_LIMIT = 8;
const TEXT_CANDIDATE_LIMIT = 64;
const ID_MAX = 200;

const WRITE_TOOLS = new Set(['write', 'edit']);
const DELIMITERS = /[\s`'"<>()[\]{}|,;，。；：、！？（）《》「」“”‘’*]+/u;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/giu;
const FILE_URL_RE = /file:\/\/(\/[^\s`'"<>()[\]]+)/giu;
const BARE_FILE_RE = /^[^/]*\p{L}[^/]*\.[A-Za-z0-9]{1,10}$/u;

const KINDS: Record<string, BotArtifactKind> = {};
const register = (kind: BotArtifactKind, list: string) => {
  for (const ext of list.split(' ')) KINDS[ext] = kind;
};
register('image', 'png jpg jpeg gif webp svg bmp ico avif');
register('markdown', 'md markdown mdx');
register('html', 'html htm');
register('pdf', 'pdf');
register(
  'text',
  'txt log csv tsv json jsonl yaml yml toml xml ini conf ts tsx js jsx mjs cjs py rb go rs java kt swift c h cpp hpp cs php sh bash zsh sql css scss less vue svelte lua dart diff patch'
);

export function artifactKind(name: string): BotArtifactKind {
  const ext = path.extname(name).slice(1).toLowerCase();
  return KINDS[ext] ?? 'other';
}

const NOT_OPENABLE = new Set(
  'app command tool sh bash zsh csh fish exe bat cmd com msi ps1 vbs scpt applescript workflow action jar pkg mpkg dmg terminal py rb pl php js mjs cjs jxa webloc inetloc url fileloc'.split(
    ' '
  )
);

/** 「用默认应用打开」只给非可执行、非脚本文件；其余只能在访达中显示 */
export function isOpenableArtifact(name: string, mode: number): boolean {
  return (mode & 0o111) === 0 && !NOT_OPENABLE.has(path.extname(name).slice(1).toLowerCase());
}

const idText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= ID_MAX;

/** renderer 只给聊天 + 条目 / 会话消息标识；路径与工作区根由 Main 推导 */
export function parseArtifactTarget(input: unknown): BotArtifactTarget | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { chatId, entryId, conversationId, messageIndex } = input as Record<string, unknown>;
  if (!isBotId(chatId)) return null;
  if (entryId !== undefined) return idText(entryId) ? { chatId, entryId } : null;
  return idText(conversationId) &&
    Number.isSafeInteger(messageIndex) &&
    (messageIndex as number) >= 0
    ? { chatId, conversationId, messageIndex: messageIndex as number }
    : null;
}

const decode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** 正文里出现的路径：绝对路径、含目录的相对路径、带扩展名的文件名（是否存在由解析阶段判断） */
export function textPathCandidates(text: string): string[] {
  const cleaned = text
    .replace(FILE_URL_RE, (_match, file: string) => ` ${decode(file)} `)
    .replace(URL_RE, ' ');
  const out: string[] = [];
  for (const raw of cleaned.split(DELIMITERS)) {
    const token = raw.replace(/[.:!?。]+$/u, '').replace(/:\d+(?::\d+)?$/u, '');
    if (!token || token.startsWith('-') || token.startsWith('~')) continue;
    const looksLikePath = token.includes('/') ? /[^/]/u.test(token) : BARE_FILE_RE.test(token);
    if (looksLikePath && !out.includes(token)) out.push(token);
    if (out.length >= TEXT_CANDIDATE_LIMIT) break;
  }
  return out;
}

const pathArg = (args: unknown): string | undefined => {
  if (!args || typeof args !== 'object') return undefined;
  const { path: value, file_path: filePath } = args as Record<string, unknown>;
  const candidate = typeof value === 'string' ? value : filePath;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
};

/** 一轮消息里的候选路径：写文件类工具在前，助手正文里提到的在后 */
export function artifactCandidates(messages: readonly ProjectedMessage[]): string[] {
  const writes: string[] = [];
  const mentioned: string[] = [];
  for (const message of messages) {
    if (message.role === 'toolResult') {
      for (const change of message.fileChanges ?? [])
        if (change.type !== 'delete') writes.push(change.path);
      continue;
    }
    if (message.role !== 'assistant') continue;
    for (const part of message.content) {
      if (part.type === 'toolCall' && WRITE_TOOLS.has(part.name)) {
        const file = pathArg(part.arguments);
        if (file) writes.push(file);
      } else if (part.type === 'text') {
        mentioned.push(...textPathCandidates(part.text));
      }
    }
  }
  return [...new Set([...writes, ...mentioned])];
}

/** 助手消息所在的一轮：前一条用户消息之后到下一条用户消息之前 */
export function turnBounds(
  messages: readonly ProjectedMessage[],
  index: number
): { start: number; end: number } | null {
  if (messages[index]?.role !== 'assistant') return null;
  let start = index;
  while (start > 0 && messages[start - 1].role !== 'user') start--;
  let end = index + 1;
  while (end < messages.length && messages[end].role !== 'user') end++;
  return { start, end };
}

const replyText = (message: ProjectedMessage): string =>
  message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();

/** 群 bot 条目 = 成员会话一轮的最终回复：按文本找最近的那一轮 */
export function turnOfReply(
  messages: readonly ProjectedMessage[],
  text: string
): { start: number; end: number } | null {
  const target = text.trim();
  if (!target) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && replyText(messages[i]) === target)
      return turnBounds(messages, i);
  }
  return null;
}

function realRootOf(root: string): string | null {
  try {
    return realpathSync(root);
  } catch {
    return null;
  }
}

/** 解析符号链接后必须仍在根内且是普通文件 */
function insideFile(realRoot: string, abs: string): { real: string; size: number } | null {
  try {
    const real = realpathSync(abs);
    const rel = path.relative(realRoot, real);
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
      return null;
    const stat = statSync(real);
    return stat.isFile() ? { real, size: stat.size } : null;
  } catch {
    return null;
  }
}

/** 候选路径 → 位于工作区根内、存在的文件卡片（按真实路径去重，最多 limit 张） */
export function resolveArtifacts(
  root: string,
  candidates: readonly string[],
  limit = BOT_ARTIFACT_LIMIT
): BotArtifact[] {
  const realRoot = realRootOf(root);
  if (!realRoot) return [];
  const seen = new Set<string>();
  const out: BotArtifact[] = [];
  for (const candidate of candidates) {
    if (out.length >= limit) break;
    if (!candidate || candidate.startsWith('~')) continue;
    const file = insideFile(realRoot, path.resolve(root, candidate));
    if (!file || seen.has(file.real)) continue;
    seen.add(file.real);
    const name = path.basename(file.real);
    out.push({
      rel: path.relative(realRoot, file.real),
      name,
      size: file.size,
      kind: artifactKind(name),
    });
  }
  return out;
}

/** 预览 / 打开前的二次校验：只接受根内相对路径，返回真实路径 */
export function resolveArtifactFile(root: string, rel: string): string | null {
  if (!rel || path.isAbsolute(rel)) return null;
  const realRoot = realRootOf(root);
  return realRoot ? (insideFile(realRoot, path.resolve(realRoot, rel))?.real ?? null) : null;
}
