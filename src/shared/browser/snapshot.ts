/**
 * 页面快照：页内脚本抽出扁平条目（角色 / 名称 / 深度 / ref），这里做校验与渲染。
 * 纯逻辑，不碰 Electron；ref 只认 `e<n>`，点/填只能用最近一次快照里的 ref。
 */

export interface SnapshotEntry {
  role: string;
  name: string;
  depth: number;
  /** 可交互节点才有；对应页内 `data-enso-ref` */
  ref?: string;
  /** 输入框当前值 / 链接 href 等 */
  value?: string;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  refs: string[];
  text: string;
}

const REF_PATTERN = /^e\d{1,5}$/;
const MAX_DEPTH = 64;
const MAX_ENTRIES = 5000;
const ENTRY_KEYS = new Set(['role', 'name', 'depth', 'ref', 'value']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function parseEntry(value: unknown): SnapshotEntry | null {
  if (!isRecord(value)) return null;
  if (!Object.keys(value).every((key) => ENTRY_KEYS.has(key))) return null;
  const { role, name, depth, ref, value: val } = value;
  if (typeof role !== 'string' || !role) return null;
  if (typeof name !== 'string') return null;
  if (!Number.isInteger(depth) || (depth as number) < 0 || (depth as number) > MAX_DEPTH) {
    return null;
  }
  if (ref !== undefined && (typeof ref !== 'string' || !REF_PATTERN.test(ref))) return null;
  if (val !== undefined && typeof val !== 'string') return null;
  const entry: SnapshotEntry = { role, name, depth: depth as number };
  if (ref !== undefined) entry.ref = ref;
  if (val !== undefined) entry.value = val;
  return entry;
}

/** 收窄 `executeJavaScript` 返回的页内条目；任一条不合法整体拒绝。 */
export function parseSnapshotEntries(raw: unknown): SnapshotEntry[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_ENTRIES) return null;
  const entries: SnapshotEntry[] = [];
  for (const item of raw) {
    const entry = parseEntry(item);
    if (!entry) return null;
    entries.push(entry);
  }
  return entries;
}

const quote = (text: string): string =>
  `"${text.replace(/\s+/g, ' ').trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function renderSnapshot(
  page: { url: string; title: string },
  entries: readonly SnapshotEntry[]
): BrowserSnapshot {
  const refs: string[] = [];
  const lines = [`- Page URL: ${page.url}`, `- Page Title: ${page.title}`, '- Page Snapshot:'];
  for (const entry of entries) {
    let line = `${'  '.repeat(entry.depth)}- ${entry.role} ${quote(entry.name)}`;
    if (entry.ref) {
      refs.push(entry.ref);
      line += ` [ref=${entry.ref}]`;
    }
    if (entry.value !== undefined && entry.value !== '') {
      line += `: ${entry.value.replace(/\s+/g, ' ').trim()}`;
    }
    lines.push(line);
  }
  return { url: page.url, title: page.title, refs, text: lines.join('\n') };
}

export function isKnownRef(snapshot: BrowserSnapshot | undefined, ref: string): boolean {
  return Boolean(snapshot && REF_PATTERN.test(ref) && snapshot.refs.includes(ref));
}
