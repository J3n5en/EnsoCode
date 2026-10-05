import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { stripBotNotesUpdate } from '../../../shared/bots/notes';

const NEWLINE = 0x0a;
const MARKER = Buffer.from('<delegation-result');
const HEAD_RE = /^<delegation-results? id="([^"]*)"/u;
const CHUNK = 256 * 1024;

interface FileScan {
  ino: number;
  /** 已处理到的完整行末尾 */
  offset: number;
  ids: Set<string>;
}

function idsOfLine(line: Buffer, into: Set<string>): void {
  if (line.indexOf(MARKER) < 0) return;
  let entry: { type?: unknown; message?: { role?: unknown; content?: unknown } };
  try {
    entry = JSON.parse(line.toString('utf8'));
  } catch {
    return;
  }
  if (entry?.type !== 'message' || entry.message?.role !== 'user') return;
  const content = entry.message.content;
  const texts =
    typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? content.flatMap((part: { type?: string; text?: unknown }) =>
            part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []
          )
        : [];
  for (const text of texts) {
    const id = HEAD_RE.exec(stripBotNotesUpdate(text).trimStart())?.[1];
    if (id) into.add(id);
  }
}

/**
 * 会话 jsonl 里已开始处理的委派结果 id（用户消息以 `<delegation-result(s) id=…>` 开头）。
 * 每个文件首次全量扫一次，之后只读追加部分；文件被替换（inode 变化或变短）则重扫。
 */
export class StartedDeliveryIndex {
  private readonly scans = new Map<string, FileScan>();

  has(file: string, deliveryId: string): boolean {
    let fd: number;
    try {
      fd = openSync(file, 'r');
    } catch {
      this.scans.delete(file);
      return false;
    }
    try {
      const { ino, size } = fstatSync(fd);
      let scan = this.scans.get(file);
      if (!scan || scan.ino !== ino || scan.offset > size) {
        scan = { ino, offset: 0, ids: new Set() };
        this.scans.set(file, scan);
      }
      if (scan.ids.has(deliveryId)) return true;
      this.advance(fd, scan, size);
      return scan.ids.has(deliveryId);
    } finally {
      closeSync(fd);
    }
  }

  forget(file: string): void {
    this.scans.delete(file);
  }

  private advance(fd: number, scan: FileScan, size: number): void {
    let carry = Buffer.alloc(0);
    let position = scan.offset;
    while (position < size) {
      const length = Math.min(CHUNK, size - position);
      const chunk = Buffer.allocUnsafe(length);
      const read = readSync(fd, chunk, 0, length, position);
      if (read <= 0) break;
      position += read;
      const data = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, read)]) : chunk;
      let start = 0;
      for (let at = data.indexOf(NEWLINE); at >= 0; at = data.indexOf(NEWLINE, start)) {
        idsOfLine(data.subarray(start, at), scan.ids);
        start = at + 1;
      }
      scan.offset = position - (data.length - start);
      carry = Buffer.from(data.subarray(start));
    }
    // 末行可能尚未写完：能解析就先记下，但水位不越过它
    if (carry.length > 0) idsOfLine(carry, scan.ids);
  }
}
