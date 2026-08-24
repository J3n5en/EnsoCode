import type { ExternalSessionSource, SimpleMessage } from '@shared/types/sessionImport';
import { listClaudeSessions, readClaudeSession } from './claudeCode';
import { listCodexSessions, readCodexSession } from './codex';
import { writePiSession } from './piJsonl';

/** 列出各本地 AI 应用在某项目目录下的会话（无会话的应用不返回） */
export function listExternalSessions(projectPath: string): ExternalSessionSource[] {
  const sources: ExternalSessionSource[] = [
    {
      sourceId: 'claude-code',
      sourceName: 'Claude Code',
      sessions: listClaudeSessions(projectPath),
    },
    { sourceId: 'codex', sourceName: 'Codex', sessions: listCodexSessions(projectPath) },
  ];
  return sources.filter((source) => source.sessions.length > 0);
}

/** 读取外部会话的拉平消息（预览用） */
export function readExternalSession(sourceId: string, sessionPath: string): SimpleMessage[] {
  if (sourceId === 'claude-code') return readClaudeSession(sessionPath).messages;
  if (sourceId === 'codex') return readCodexSession(sessionPath).messages;
  return [];
}

/** 把外部会话转成 pi jsonl，返回可 resume 的文件路径与标题 */
export function importExternalSession(
  sourceId: string,
  sessionPath: string,
  projectPath: string,
  sessionDir: string
): { sessionFile: string; title: string; messageCount: number } | null {
  const parsed =
    sourceId === 'claude-code'
      ? readClaudeSession(sessionPath)
      : sourceId === 'codex'
        ? readCodexSession(sessionPath)
        : null;
  if (!parsed || parsed.messages.length === 0) return null;
  const sessionFile = writePiSession(projectPath, parsed.messages, sessionDir);
  return { sessionFile, title: parsed.title, messageCount: parsed.messages.length };
}
