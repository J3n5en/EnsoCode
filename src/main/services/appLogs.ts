import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { crc32, deflateRaw } from 'node:zlib';
import {
  type AppLogEntry,
  type AppLogLevel,
  classifyWorkerExitLevel,
  logLineTime,
  parseAppLogLines,
  parsePluginLogLines,
  parseStampedLog,
  redactSecrets,
  summarizeErrors,
} from '@shared/appLog';

const deflateRawAsync = promisify(deflateRaw);
const EXPORT_MAX_BYTES_PER_FILE = 16 * 1024 * 1024;

/** 结构化日志目录（相对 userData）。放在 agent/ 下且以 .log 结尾，存储页「日志」清理会一并覆盖 */
export const APP_LOG_DIR = 'agent/logs';
const PLUGIN_LOG_DIR = 'extension-plugins/logs';
const WORKER_EXIT_LOG = 'agent/worker-exits.log';
/** 只导出、不进汇总的旧式日志 */
const EXTRA_EXPORT_LOGS = ['agent/compaction.log', 'agent/interrupted-turns.log'];
const SUMMARY_TAIL_BYTES = 512 * 1024;
export const ERROR_SUMMARY_LIMIT = 50;

export function appLogFile(userData: string, name: 'main' | 'agent'): string {
  return path.join(userData, APP_LOG_DIR, `${name}.log`);
}

type LogKind = 'jsonl' | 'plugin' | 'stamped' | 'other';

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

async function logFiles(userData: string): Promise<{ rel: string; kind: LogKind }[]> {
  const out: { rel: string; kind: LogKind }[] = [];
  for (const name of await listDir(path.join(userData, APP_LOG_DIR))) {
    if (name.endsWith('.log')) out.push({ rel: `${APP_LOG_DIR}/${name}`, kind: 'jsonl' });
  }
  for (const name of await listDir(path.join(userData, PLUGIN_LOG_DIR))) {
    if (/\.log(?:\.1)?$/.test(name)) out.push({ rel: `${PLUGIN_LOG_DIR}/${name}`, kind: 'plugin' });
  }
  out.push({ rel: WORKER_EXIT_LOG, kind: 'stamped' });
  for (const rel of EXTRA_EXPORT_LOGS) out.push({ rel, kind: 'other' });
  return out;
}

async function readTail(file: string, maxBytes: number): Promise<string> {
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(file, 'r');
    const { size } = await fh.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buffer, 0, length, size - length);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    return length < size ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (fh !== null) await fh.close().catch(() => {});
  }
}

/** 「最近出错了什么」：各来源 error（可含 warn），倒序，已脱敏 */
export async function collectErrorSummary(
  userData: string,
  options: { minLevel: AppLogLevel; limit: number }
): Promise<AppLogEntry[]> {
  const entries: AppLogEntry[] = [];
  for (const { rel, kind } of await logFiles(userData)) {
    if (kind === 'other') continue;
    const text = await readTail(path.join(userData, rel), SUMMARY_TAIL_BYTES);
    if (!text) continue;
    if (kind === 'jsonl') entries.push(...parseAppLogLines(text));
    else if (kind === 'stamped')
      entries.push(...parseStampedLog(text, 'agent', classifyWorkerExitLevel));
    else
      entries.push(...parsePluginLogLines(text, path.basename(rel).replace(/\.log(?:\.1)?$/, '')));
  }
  return summarizeErrors(entries, options);
}

/** 流式按行裁剪时间窗并脱敏；无时间戳的续行跟随上一行，超大文件只读末尾上限以免卡顿 */
async function sliceWindowFile(
  file: string,
  size: number,
  cutoff: number,
  mtime: number
): Promise<string> {
  const start = size > EXPORT_MAX_BYTES_PER_FILE ? size - EXPORT_MAX_BYTES_PER_FILE : 0;
  const stream = createReadStream(file, { encoding: 'utf8', start });
  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  let keep = mtime >= cutoff;
  let skipPartialFirst = start > 0;
  const out: string[] = [];
  try {
    for await (const line of rl) {
      if (skipPartialFirst) {
        skipPartialFirst = false;
        continue;
      }
      const time = logLineTime(line);
      if (time !== null) keep = time >= cutoff;
      if (keep && line) out.push(redactSecrets(line));
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return out.length > 0 ? `${out.join('\n')}\n` : '';
}

export async function exportLogs(
  userData: string,
  target: string,
  options: { hours: number; now?: number; appInfo?: Record<string, unknown> }
): Promise<{ files: number; bytes: number }> {
  const now = options.now ?? Date.now();
  const cutoff = now - options.hours * 3600_000;
  const entries: ZipEntry[] = [];
  for (const { rel } of await logFiles(userData)) {
    const file = path.join(userData, rel);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(file);
    } catch {
      continue;
    }
    if (!info.isFile() || info.mtimeMs < cutoff) continue;
    const text = await sliceWindowFile(file, info.size, cutoff, info.mtimeMs);
    if (text) entries.push({ name: rel, data: Buffer.from(text, 'utf8'), mtime: info.mtimeMs });
  }
  const fileCount = entries.length;
  entries.push({
    name: 'export-info.json',
    data: Buffer.from(
      JSON.stringify(
        { exportedAt: new Date(now).toISOString(), hours: options.hours, ...options.appInfo },
        null,
        2
      )
    ),
    mtime: now,
  });
  const zip = await createZip(entries);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, zip);
  return { files: fileCount, bytes: zip.length };
}

interface ZipEntry {
  name: string;
  data: Buffer;
  mtime: number;
}

function dosTime(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** 最小 zip 写出（deflate，无 zip64）；导出体积受滚动上限约束，远不到 4GB */
async function createZip(entries: ZipEntry[]): Promise<Buffer> {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = await deflateRawAsync(entry.data);
    const crc = crc32(entry.data);
    const { time, date } = dosTime(entry.mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
