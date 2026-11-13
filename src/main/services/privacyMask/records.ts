import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  PRIVACY_MASK_ENTRY,
  type PrivacyMaskRecord,
  parsePrivacyMaskRecord,
} from '@shared/privacyMask/report';

const DAY = 86_400_000;
export const LEDGER_RETENTION_DAYS = 30;
const MAX_RECORDS = 2000;

function parseLines(text: string, pick: (row: Record<string, unknown>) => unknown) {
  const out: PrivacyMaskRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const record = parsePrivacyMaskRecord(pick(row));
      if (record) out.push(record);
    } catch {
      // 坏行跳过
    }
  }
  return out;
}

export function extractSessionRecords(text: string): PrivacyMaskRecord[] {
  if (!text.includes(PRIVACY_MASK_ENTRY)) return [];
  return parseLines(
    text
      .split('\n')
      .filter((l) => l.includes(PRIVACY_MASK_ENTRY))
      .join('\n'),
    (row) => (row.type === 'custom' && row.customType === PRIVACY_MASK_ENTRY ? row.data : undefined)
  );
}

export async function readLedger(file: string, since: number): Promise<PrivacyMaskRecord[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  return parseLines(text, (row) => row).filter((r) => r.at >= since);
}

const lastPrune = new Map<string, number>();

async function pruneLedger(file: string, now: number): Promise<void> {
  const keep = await readLedger(file, now - LEDGER_RETENTION_DAYS * DAY);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, keep.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8');
  await rename(tmp, file);
}

// 同一账本的写操作排成进程内串行链：清理是「读出 → 写临时文件 → rename」，
// 与并发追加交错时，读出之后落盘的那条会被 rename 整文件覆盖掉
const ledgerChains = new Map<string, Promise<void>>();

/** 追加一条；每个进程每天顺手按保留期清理一次 */
export function appendLedger(
  file: string,
  record: PrivacyMaskRecord,
  now = Date.now(),
  forcePrune = false
): Promise<void> {
  const run = (ledgerChains.get(file) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const last = lastPrune.get(file);
      if (forcePrune || last === undefined || now - last > DAY) {
        lastPrune.set(file, now);
        await pruneLedger(file, now).catch(() => {});
      }
      await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
    });
  ledgerChains.set(file, run);
  return run;
}

const sessionCache = new Map<
  string,
  { mtimeMs: number; size: number; records: PrivacyMaskRecord[] }
>();

async function sessionRecords(file: string): Promise<PrivacyMaskRecord[]> {
  try {
    const { mtimeMs, size } = await stat(file);
    const hit = sessionCache.get(file);
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.records;
    const records = extractSessionRecords(await readFile(file, 'utf8'));
    sessionCache.set(file, { mtimeMs, size, records });
    return records;
  } catch {
    return [];
  }
}

export async function collectRecords(opts: {
  sessionDir: string;
  ledgerFile: string;
  since: number;
}): Promise<PrivacyMaskRecord[]> {
  let names: string[] = [];
  try {
    names = (await readdir(opts.sessionDir)).filter((n) => n.endsWith('.jsonl'));
  } catch {
    // 目录不存在即无会话记录
  }
  const all: PrivacyMaskRecord[] = [];
  for (const name of names) all.push(...(await sessionRecords(path.join(opts.sessionDir, name))));
  all.push(...(await readLedger(opts.ledgerFile, opts.since)));
  return all
    .filter((r) => r.at >= opts.since)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_RECORDS);
}
