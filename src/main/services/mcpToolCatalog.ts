import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app } from '@platform';
import type { McpServerEntry } from '@shared/types';

interface CatalogRow {
  signature: string;
  tools: string[];
}

/** 连接配置签名：配置变了缓存即作废；只存哈希，env 与请求头明文不落盘 */
function signature(server: McpServerEntry): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        server.transport,
        server.command,
        server.args,
        server.env,
        server.url,
        // 只在有请求头时追加：旧条目的签名不变，缓存不失效
        ...(server.headers ? [server.headers] : []),
      ])
    )
    .digest('hex')
    .slice(0, 16);
}

const isRow = (value: unknown): value is CatalogRow =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as CatalogRow).signature === 'string' &&
  Array.isArray((value as CatalogRow).tools) &&
  (value as CatalogRow).tools.every((tool) => typeof tool === 'string');

/** 按需 MCP 目录用的工具名缓存（userData/mcp-tool-catalog.json），来源是设置页占用探测 */
export class McpToolCatalogStore {
  private cache: Record<string, CatalogRow> | null = null;

  constructor(private readonly file: string) {}

  names(server: McpServerEntry): string[] | undefined {
    const row = this.load()[server.id];
    return row && row.signature === signature(server) ? row.tools : undefined;
  }

  record(server: McpServerEntry, tools: string[]): void {
    if (tools.length === 0) return;
    const rows = this.load();
    const next = { signature: signature(server), tools };
    if (JSON.stringify(rows[server.id]) === JSON.stringify(next)) return;
    this.save({ ...rows, [server.id]: next });
  }

  /** 只保留仍在设置里的 server：删除 server 时清掉本地副本 */
  retain(ids: Iterable<string>): void {
    const keep = new Set(ids);
    const rows = this.load();
    const kept = Object.entries(rows).filter(([id]) => keep.has(id));
    if (kept.length !== Object.keys(rows).length) this.save(Object.fromEntries(kept));
  }

  private load(): Record<string, CatalogRow> {
    if (this.cache) return this.cache;
    let rows: Record<string, CatalogRow> = {};
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, 'utf-8')) as { servers?: unknown };
        const servers = parsed.servers;
        if (servers && typeof servers === 'object') {
          rows = Object.fromEntries(Object.entries(servers).filter(([, row]) => isRow(row)));
        }
      }
    } catch {
      rows = {};
    }
    this.cache = rows;
    return rows;
  }

  private save(rows: Record<string, CatalogRow>): void {
    this.cache = rows;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ servers: rows }));
    renameSync(tmp, this.file);
  }
}

let singleton: McpToolCatalogStore | undefined;

export function getMcpToolCatalog(): McpToolCatalogStore {
  singleton ??= new McpToolCatalogStore(
    path.join(app.getPath('userData'), 'mcp-tool-catalog.json')
  );
  return singleton;
}
