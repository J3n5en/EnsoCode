import os from 'node:os';
import type {
  ExternalSession,
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

interface SessionReader {
  sourceId: ExternalSessionSourceId;
  sourceName: string;
  list: (projectPath: string, home: string) => ExternalSession[];
  read: (sessionPath: string) => { title: string; messages: SimpleMessage[] };
}

const READERS: SessionReader[] = [
  {
    sourceId: 'claude-code',
    sourceName: 'Claude Code',
    list: listClaudeSessions,
    read: readClaudeSession,
  },
  { sourceId: 'codex', sourceName: 'Codex', list: listCodexSessions, read: readCodexSession },
  { sourceId: 'grok', sourceName: 'Grok CLI', list: listGrokSessions, read: readGrokSession },
  { sourceId: 'cursor', sourceName: 'Cursor', list: listCursorSessions, read: readCursorSession },
  { sourceId: 'pi', sourceName: 'pi', list: listPiSessions, read: readPiV3Session },
  {
    sourceId: 'oh-my-pi',
    sourceName: 'oh-my-pi',
    list: listOhMyPiSessions,
    read: readPiV3Session,
  },
  {
    sourceId: 'factory',
    sourceName: 'Factory',
    list: listFactorySessions,
    read: readFactorySession,
  },
  {
    sourceId: 'opencode',
    sourceName: 'OpenCode',
    list: listOpencodeSessions,
    read: readOpencodeSession,
  },
  {
    sourceId: 'gemini-cli',
    sourceName: 'Gemini CLI',
    list: listGeminiSessions,
    read: readGeminiSession,
  },
];

const readerOf = (sourceId: string): SessionReader | undefined =>
  READERS.find((reader) => reader.sourceId === sourceId);

/** 列出各本地 AI 应用在某项目目录下的会话（无会话的应用不返回） */
export function listExternalSessions(
  projectPath: string,
  home = os.homedir()
): ExternalSessionSource[] {
  return READERS.map((reader) => ({
    sourceId: reader.sourceId,
    sourceName: reader.sourceName,
    sessions: reader.list(projectPath, home),
  })).filter((source) => source.sessions.length > 0);
}

/** 读取外部会话的拉平消息（预览用） */
export function readExternalSession(sourceId: string, sessionPath: string): SimpleMessage[] {
  return readerOf(sourceId)?.read(sessionPath).messages ?? [];
}

/** 把外部会话转成 pi jsonl，返回可 resume 的文件路径与标题 */
export function importExternalSession(
  sourceId: string,
  sessionPath: string,
  projectPath: string,
  sessionDir: string
): { sessionFile: string; title: string; messageCount: number } | null {
  const parsed = readerOf(sourceId)?.read(sessionPath);
  if (!parsed || parsed.messages.length === 0) return null;
  const sessionFile = writePiSession(projectPath, parsed.messages, sessionDir);
  return { sessionFile, title: parsed.title, messageCount: parsed.messages.length };
}
