/**
 * 按文件签名（mtime+size）记住整文件解析结果。会话 jsonl 动辄几十 MB，
 * 远端每次取尾窗、上翻一页都整文件同步解析会卡住主进程；文件没变就复用。
 * 按条数和文件字节预算 LRU 淘汰，空闲一段时间整体释放，不长期占内存。
 */
export interface FileMemoOptions {
  stat(file: string): { mtimeMs: number; size: number } | null;
  maxEntries?: number;
  maxBytes?: number;
  idleMs?: number;
}

export function createFileMemo<T>(options: FileMemoOptions) {
  const maxEntries = options.maxEntries ?? 4;
  const maxBytes = options.maxBytes ?? 160 * 1024 * 1024;
  const idleMs = options.idleMs ?? 5 * 60_000;
  const entries = new Map<string, { sig: string; size: number; value: T }>();
  let bytes = 0;
  let idle: ReturnType<typeof setTimeout> | null = null;

  const remove = (id: string): void => {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    bytes -= entry.size;
  };
  const clear = (): void => {
    entries.clear();
    bytes = 0;
    if (idle) clearTimeout(idle);
    idle = null;
  };
  const touch = (): void => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(clear, idleMs);
    idle.unref?.();
  };

  return {
    get(file: string, key: string, load: (file: string) => T): T {
      const id = `${key}\0${file}`;
      const stat = options.stat(file);
      const sig = stat ? `${stat.mtimeMs}:${stat.size}` : '';
      const hit = entries.get(id);
      if (stat && hit?.sig === sig) {
        entries.delete(id);
        entries.set(id, hit);
        touch();
        return hit.value;
      }
      remove(id);
      const value = load(file);
      if (!stat || stat.size > maxBytes) return value;
      entries.set(id, { sig, size: stat.size, value });
      bytes += stat.size;
      for (const oldest of entries.keys()) {
        if (entries.size <= maxEntries && bytes <= maxBytes) break;
        remove(oldest);
      }
      touch();
      return value;
    },
    clear,
  };
}
