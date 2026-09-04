import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadUsageProjectAliases } from './aliases';
import { type ParsedSession, parseSessionJsonl } from './parseSession';
import { applyUsageProjectAliases } from './projectLabel';

export function usageLedgerDir(sessionDir: string): string {
  return path.join(path.dirname(sessionDir), 'usage-ledger');
}

function snapshotPath(dir: string, sessionId: string): string {
  return path.join(dir, `${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

export async function writeLedgerSnapshot(
  sessionDir: string,
  parsed: ParsedSession
): Promise<void> {
  const dir = usageLedgerDir(sessionDir);
  await mkdir(dir, { recursive: true });
  await writeFile(snapshotPath(dir, parsed.sessionId), JSON.stringify(parsed), 'utf8');
}

/** 一轮结束后把当前 jsonl 的用量快照写入账本（覆盖该 sessionId）。文件缺失则忽略。 */
export async function ingestSessionJsonl(sessionDir: string, sessionFile: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(sessionFile, 'utf8');
  } catch {
    return;
  }
  const parsed = parseSessionJsonl(text);
  if (parsed) {
    await writeLedgerSnapshot(
      sessionDir,
      applyUsageProjectAliases(parsed, loadUsageProjectAliases())
    );
  }
}

export async function loadLedger(sessionDir: string): Promise<ParsedSession[]> {
  const dir = usageLedgerDir(sessionDir);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const sessions: ParsedSession[] = [];
  for (const name of names) {
    try {
      const raw = JSON.parse(await readFile(path.join(dir, name), 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object') continue;
      const value = raw as Partial<ParsedSession>;
      if (typeof value.sessionId !== 'string' || !Array.isArray(value.records)) continue;
      sessions.push({
        sessionId: value.sessionId,
        project: typeof value.project === 'string' ? value.project : '',
        ...(typeof value.cwd === 'string' && value.cwd ? { cwd: value.cwd } : {}),
        records: value.records,
        spans: Array.isArray(value.spans) ? value.spans : [],
        activeMs: typeof value.activeMs === 'number' ? value.activeMs : 0,
        userMessages: typeof value.userMessages === 'number' ? value.userMessages : 0,
      });
    } catch {}
  }
  return sessions;
}
