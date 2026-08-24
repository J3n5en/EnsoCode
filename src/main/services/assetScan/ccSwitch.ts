import { createHash } from 'node:crypto';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import type { DiscoveredInstruction } from './instructions';
import type { DiscoveredMcpServer } from './mcp';
import type { DiscoveredSkill } from './skills';

const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const asStringRecord = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object') return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') result[key] = item;
  }
  return result;
};

function openDb(file: string): Database.Database | null {
  if (!fs.existsSync(file)) return null;
  try {
    return new Database(file, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(table);
  return Boolean(row);
}

/** CC Switch 的 mcp_servers 表：server_config 为 JSON 字符串 */
export function readCcSwitchMcp(dbFile: string): DiscoveredMcpServer[] {
  const db = openDb(dbFile);
  if (!db) return [];

  try {
    if (!tableExists(db, 'mcp_servers')) return [];
    const rows = db.prepare('SELECT name, server_config FROM mcp_servers').all() as Array<{
      name?: string;
      server_config?: string;
    }>;

    const servers: DiscoveredMcpServer[] = [];
    for (const row of rows) {
      const name = asText(row.name);
      if (!name || !row.server_config) continue;

      let config: Record<string, unknown>;
      try {
        config = JSON.parse(row.server_config) as Record<string, unknown>;
      } catch {
        continue;
      }

      const url = asText(config.url);
      const command = asText(config.command);
      if (!command && !url) continue;

      const rawType = asText(config.type).toLowerCase();
      servers.push({
        name,
        transport: rawType === 'sse' ? 'sse' : rawType === 'http' ? 'http' : url ? 'http' : 'stdio',
        command: command || undefined,
        args: command ? asStringArray(config.args) : undefined,
        env: command ? asStringRecord(config.env) : undefined,
        url: url || undefined,
      });
    }
    return servers;
  } finally {
    db.close();
  }
}

/** CC Switch 的 skills 表：directory 指向本地技能目录 */
export function readCcSwitchSkills(dbFile: string, groupName: string): DiscoveredSkill[] {
  const db = openDb(dbFile);
  if (!db) return [];

  try {
    if (!tableExists(db, 'skills')) return [];
    const rows = db.prepare('SELECT name, description, directory FROM skills').all() as Array<{
      name?: string;
      description?: string;
      directory?: string;
    }>;

    return rows
      .filter((row) => asText(row.directory) && fs.existsSync(asText(row.directory)))
      .map((row) => ({
        name: asText(row.name),
        description: asText(row.description),
        path: asText(row.directory),
        groupName,
      }))
      .filter((skill) => skill.name);
  } finally {
    db.close();
  }
}

/** CC Switch 的 prompts 表：指令内容直接存库，没有对应文件 */
export function readCcSwitchPrompts(dbFile: string): DiscoveredInstruction[] {
  const db = openDb(dbFile);
  if (!db) return [];

  try {
    if (!tableExists(db, 'prompts')) return [];
    const rows = db.prepare('SELECT name, app_type, content FROM prompts').all() as Array<{
      name?: string;
      app_type?: string;
      content?: string;
    }>;

    return rows
      .filter((row) => asText(row.content))
      .map((row) => {
        const content = asText(row.content);
        const appType = asText(row.app_type);
        return {
          name: asText(row.name) || appType || 'prompt',
          content,
          location: appType ? `cc-switch · ${appType}` : 'cc-switch',
          bytes: Buffer.byteLength(content, 'utf8'),
          hash: createHash('sha256').update(content).digest('hex'),
        };
      });
  } finally {
    db.close();
  }
}
