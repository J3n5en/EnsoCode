import type { InstructionEntry, McpServerEntry, SkillEntry } from '@shared/types';
import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';
import { readSettingsState } from '../services/agentHost';
import { snapshotBuiltinOccupancyTools } from '../../agent/builtinOccupancy';
import {
  instructionReader,
  occupancyForBuiltinTools,
  occupancyForInstructions,
  occupancyForMcp,
  occupancyForSkills,
  parseOccupancyIds,
} from '../services/assetOccupancy';
import { collectAssetImport, scanLocalAssets } from '../services/assetScan';
import { listProjectSkills } from '../services/assetScan/skills';
import {
  deleteInstruction,
  readInstruction,
  writeInstruction,
  writeInstructionSource,
} from '../services/instructionStore';
import { listMcpOccupancyTools } from '../services/mcpOccupancy';
import { readSettings } from './settings';

function settingsState(): Record<string, unknown> {
  const packed = readSettings()?.['enso-settings'];
  if (!packed || typeof packed !== 'object') return {};
  const state = (packed as { state?: unknown }).state;
  return state && typeof state === 'object' && !Array.isArray(state)
    ? (state as Record<string, unknown>)
    : {};
}

function asSkills(value: unknown): SkillEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is SkillEntry =>
      Boolean(entry) &&
      typeof entry === 'object' &&
      typeof (entry as SkillEntry).id === 'string' &&
      typeof (entry as SkillEntry).path === 'string'
  );
}

function asMcp(value: unknown): McpServerEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is McpServerEntry =>
      Boolean(entry) &&
      typeof entry === 'object' &&
      typeof (entry as McpServerEntry).id === 'string' &&
      typeof (entry as McpServerEntry).name === 'string'
  );
}

function asInstructions(value: unknown): InstructionEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is InstructionEntry =>
      Boolean(entry) &&
      typeof entry === 'object' &&
      typeof (entry as InstructionEntry).id === 'string'
  );
}

export function registerAssetHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.ASSETS_SCAN_LOCAL, () => scanLocalAssets());

  ipcMain.handle(
    IPC_CHANNELS.ASSETS_COLLECT_IMPORT,
    (_event, scanId: unknown, candidateIds: unknown) => {
      if (typeof scanId !== 'string' || !Array.isArray(candidateIds)) return [];
      return collectAssetImport(
        scanId,
        candidateIds.filter((id): id is string => typeof id === 'string')
      );
    }
  );

  ipcMain.handle(IPC_CHANNELS.ASSETS_LIST_PROJECT_SKILLS, (_event, cwd: unknown) => {
    if (typeof cwd !== 'string' || !cwd) return [];
    // 与 spawn 同一来源读开关：菜单预览与实际注入的 skill 集合保持一致
    return listProjectSkills(cwd, undefined, {
      includeHarness: readSettingsState()?.loadHarnessAssets === true,
    });
  });

  ipcMain.handle(IPC_CHANNELS.ASSETS_SKILL_OCCUPANCY, (_event, ids: unknown) =>
    occupancyForSkills(parseOccupancyIds(ids), asSkills(settingsState().skills))
  );

  ipcMain.handle(IPC_CHANNELS.ASSETS_INSTRUCTION_OCCUPANCY, (_event, ids: unknown) =>
    occupancyForInstructions(
      parseOccupancyIds(ids),
      instructionReader(asInstructions(settingsState().instructions), readInstruction)
    )
  );

  ipcMain.handle(IPC_CHANNELS.ASSETS_MCP_OCCUPANCY, (_event, ids: unknown) =>
    occupancyForMcp(
      parseOccupancyIds(ids),
      asMcp(settingsState().mcpServers),
      listMcpOccupancyTools
    )
  );

  ipcMain.handle(IPC_CHANNELS.ASSETS_BUILTIN_TOOL_OCCUPANCY, () =>
    occupancyForBuiltinTools(snapshotBuiltinOccupancyTools())
  );

  ipcMain.handle(
    IPC_CHANNELS.INSTRUCTIONS_READ,
    (_event, id: unknown, local: unknown, sourcePath: unknown) => {
      if (typeof id !== 'string') return { ok: false, content: '', error: 'Invalid id' };
      return readInstruction(
        id,
        local === true,
        typeof sourcePath === 'string' ? sourcePath : undefined
      );
    }
  );

  ipcMain.handle(IPC_CHANNELS.INSTRUCTIONS_WRITE, (_event, id: unknown, content: unknown) => {
    if (typeof id !== 'string' || typeof content !== 'string') return { ok: false, bytes: 0 };
    return writeInstruction(id, content);
  });

  ipcMain.handle(
    IPC_CHANNELS.INSTRUCTIONS_WRITE_SOURCE,
    (_event, id: unknown, sourcePath: unknown, content: unknown) => {
      if (typeof id !== 'string' || typeof sourcePath !== 'string' || typeof content !== 'string') {
        return { ok: false, bytes: 0, error: 'Invalid arguments' };
      }
      return writeInstructionSource(id, sourcePath, content);
    }
  );

  ipcMain.handle(IPC_CHANNELS.INSTRUCTIONS_DELETE, (_event, id: unknown) => {
    if (typeof id === 'string') deleteInstruction(id);
  });
}
