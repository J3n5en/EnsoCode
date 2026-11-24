import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ExternalSessionImportResult,
  ExternalSessionReadResult,
  ExternalSessionSource,
  ExternalSessionSourceId,
  SimpleMessage,
} from '@shared/types/sessionImport';
import { listClaudeSessions, readClaudeSession } from './claudeCode';
import { listCodexSessions, readCodexSession } from './codex';
import { listCursorSessions, readCursorSession } from './cursor';
import { listFactorySessions, readFactorySession } from './factory';
import { listGeminiSessions, readGeminiSession } from './gemini';
import { listGrokSessions, readGrokSession } from './grok';
import { listOpencodeSessions, readOpencodeSession } from './opencode';
import { listOhMyPiSessions, listPiSessions, readPiV3Session } from './pi';
import { writePiSession } from './piJsonl';
import type { ScannedSession } from './types';

interface SessionReader {
  sourceId: ExternalSessionSourceId;
  sourceName: string;
  /** 该来源允许读取的根目录；扫描到的会话 realpath 后必须仍在其内 */
  root: (home: string) => string;
  list: (projectPath: string, home: string) => ScannedSession[];
  read: (sessionPath: string) => { title: string; messages: SimpleMessage[] };
}

const READERS: SessionReader[] = [
  {
    sourceId: 'claude-code',
    sourceName: 'Claude Code',
    root: (home) => path.join(home, '.claude', 'projects'),
    list: listClaudeSessions,
    read: readClaudeSession,
  },
  {
    sourceId: 'codex',
    sourceName: 'Codex',
    root: (home) => path.join(home, '.codex', 'sessions'),
    list: listCodexSessions,
    read: readCodexSession,
  },
  {
    sourceId: 'grok',
    sourceName: 'Grok CLI',
    root: (home) => path.join(home, '.grok', 'sessions'),
    list: listGrokSessions,
    read: readGrokSession,
  },
  {
    sourceId: 'cursor',
    sourceName: 'Cursor',
    root: (home) => path.join(home, '.cursor', 'projects'),
    list: listCursorSessions,
    read: readCursorSession,
  },
  {
    sourceId: 'pi',
    sourceName: 'pi',
    root: (home) => path.join(home, '.pi', 'agent', 'sessions'),
    list: listPiSessions,
    read: readPiV3Session,
  },
  {
    sourceId: 'oh-my-pi',
    sourceName: 'oh-my-pi',
    root: (home) => path.join(home, '.omp', 'agent', 'sessions'),
    list: listOhMyPiSessions,
    read: readPiV3Session,
  },
  {
    sourceId: 'factory',
    sourceName: 'Factory',
    root: (home) => path.join(home, '.factory', 'sessions'),
    list: listFactorySessions,
    read: readFactorySession,
  },
  {
    sourceId: 'opencode',
    sourceName: 'OpenCode',
    root: (home) => path.join(home, '.local', 'share', 'opencode', 'storage'),
    list: listOpencodeSessions,
    read: readOpencodeSession,
  },
  {
    sourceId: 'gemini-cli',
    sourceName: 'Gemini CLI',
    root: (home) => path.join(home, '.gemini', 'tmp'),
    list: listGeminiSessions,
    read: readGeminiSession,
  },
];

const readerOf = (sourceId: string): SessionReader | undefined =>
  READERS.find((reader) => reader.sourceId === sourceId);

const TOKEN_TTL_MS = 30 * 60_000;

interface Grant {
  reader: SessionReader;
  root: string;
  filePath: string;
  projectPath: string;
  expiresAt: number;
}

/** 令牌 → 扫描到的会话；只存于 Main 内存，过期或重启即失效 */
const grants = new Map<string, Grant>();

/** 扫描各本地 AI 应用在某项目目录下的会话，带绝对路径，仅供 Main 内部使用 */
export function scanExternalSessions(projectPath: string, home = os.homedir()) {
  return READERS.map((reader) => ({
    reader,
    sourceId: reader.sourceId,
    sourceName: reader.sourceName,
    sessions: reader.list(projectPath, home),
  })).filter((source) => source.sessions.length > 0);
}

/** 按来源解析某个会话文件的拉平消息，仅供 Main 内部使用 */
export function readSessionMessages(sourceId: string, sessionPath: string): SimpleMessage[] {
  return readerOf(sourceId)?.read(sessionPath).messages ?? [];
}

/** 列出外部会话；每个条目换成不透明令牌，路径只留在 Main */
export function listExternalSessions(
  projectPath: string,
  home = os.homedir(),
  now = Date.now()
): ExternalSessionSource[] {
  for (const [token, grant] of grants) if (grant.expiresAt <= now) grants.delete(token);
  return scanExternalSessions(projectPath, home).map(
    ({ reader, sourceId, sourceName, sessions }) => ({
      sourceId,
      sourceName,
      sessions: sessions.map(({ path: filePath, ...session }) => {
        const token = randomUUID();
        grants.set(token, {
          reader,
          root: reader.root(home),
          filePath,
          projectPath,
          expiresAt: now + TOKEN_TTL_MS,
        });
        return { token, ...session };
      }),
    })
  );
}

type Resolved =
  | { ok: true; grant: Grant; realPath: string }
  | { ok: false; error: 'rescan' | 'denied' };

/** 令牌取回路径并 realpath 校验：仍在该来源根目录内才放行，符号链接跳出去一律拒绝 */
function resolveGrant(token: unknown, now: number): Resolved {
  const grant = typeof token === 'string' ? grants.get(token) : undefined;
  if (!grant || grant.expiresAt <= now) return { ok: false, error: 'rescan' };
  let realPath: string;
  let realRoot: string;
  try {
    realPath = fs.realpathSync(grant.filePath);
    realRoot = fs.realpathSync(grant.root);
  } catch {
    return { ok: false, error: 'rescan' };
  }
  const relative = path.relative(realRoot, realPath);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return { ok: false, error: 'denied' };
  }
  return { ok: true, grant, realPath };
}

/** 凭令牌读取外部会话的拉平消息（预览用） */
export function readExternalSession(token: unknown, now = Date.now()): ExternalSessionReadResult {
  const resolved = resolveGrant(token, now);
  if (!resolved.ok) return resolved;
  return { ok: true, messages: resolved.grant.reader.read(resolved.realPath).messages };
}

/** 凭令牌把外部会话转成 pi jsonl；cwd 取扫描时的项目目录 */
export function importExternalSession(
  token: unknown,
  sessionDir: string,
  now = Date.now()
): ExternalSessionImportResult {
  const resolved = resolveGrant(token, now);
  if (!resolved.ok) return resolved;
  const { title, messages } = resolved.grant.reader.read(resolved.realPath);
  if (messages.length === 0) return { ok: false, error: 'empty' };
  const sessionFile = writePiSession(resolved.grant.projectPath, messages, sessionDir);
  return { ok: true, sessionFile, title, messageCount: messages.length };
}
