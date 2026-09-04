import fs from 'node:fs';
import path from 'node:path';
import {
  estimateInstructionTokens,
  estimateSkillTokens,
  estimateToolsTotal,
  type OccupancyTool,
} from '@shared/occupancy';
import type {
  AssetOccupancyRow,
  InstructionEntry,
  McpServerEntry,
  SkillEntry,
} from '@shared/types';

export function parseOccupancyIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

export function occupancyForSkills(
  ids: readonly string[],
  catalog: readonly SkillEntry[]
): AssetOccupancyRow[] {
  const byId = new Map(catalog.map((entry) => [entry.id, entry]));
  return ids.map((id) => {
    const entry = byId.get(id);
    if (!entry) return { id, tokens: null };
    try {
      const content = fs.readFileSync(path.join(entry.path, 'SKILL.md'), 'utf8');
      return {
        id,
        tokens: estimateSkillTokens({
          name: entry.name,
          description: entry.description,
          content,
        }),
      };
    } catch {
      return { id, tokens: null };
    }
  });
}

export function occupancyForInstructions(
  ids: readonly string[],
  readContent: (id: string) => { ok: boolean; content: string; error?: string } | null
): AssetOccupancyRow[] {
  return ids.map((id) => {
    const result = readContent(id);
    if (!result) return { id, tokens: null };
    if (!result.ok) return { id, tokens: null, ...(result.error ? { error: result.error } : {}) };
    return { id, tokens: estimateInstructionTokens(result.content) };
  });
}

export async function occupancyForMcp(
  ids: readonly string[],
  catalog: readonly McpServerEntry[],
  listTools: (server: McpServerEntry) => Promise<OccupancyTool[]>
): Promise<AssetOccupancyRow[]> {
  const byId = new Map(catalog.map((entry) => [entry.id, entry]));
  const rows: AssetOccupancyRow[] = [];
  for (const id of ids) {
    const server = byId.get(id);
    if (!server?.enabled) {
      rows.push({ id, tokens: null });
      continue;
    }
    try {
      const tools = await listTools(server);
      rows.push({ id, tokens: estimateToolsTotal(tools), toolCount: tools.length });
    } catch (error) {
      rows.push({
        id,
        tokens: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return rows;
}

export function occupancyForBuiltinTools(
  toolsById: Readonly<Record<string, readonly OccupancyTool[]>>
): AssetOccupancyRow[] {
  return Object.entries(toolsById).map(([id, tools]) => ({
    id,
    tokens: estimateToolsTotal(tools),
    toolCount: tools.length,
  }));
}

export function instructionReader(
  catalog: readonly InstructionEntry[],
  readFile: (
    id: string,
    local: boolean,
    sourcePath?: string
  ) => {
    ok: boolean;
    content: string;
    error?: string;
  }
): (id: string) => { ok: boolean; content: string; error?: string } | null {
  const byId = new Map(catalog.map((entry) => [entry.id, entry]));
  return (id) => {
    const entry = byId.get(id);
    if (!entry) return null;
    return readFile(entry.id, entry.local, entry.sourcePath);
  };
}
