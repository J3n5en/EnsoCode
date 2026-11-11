import path from 'node:path';
import { ipcMain } from '@platform';
import { fetchPresetImport } from '@shared/presetImport';
import type { InstructionEntry, McpServerEntry, SkillEntry } from '@shared/types';
import { IPC_CHANNELS } from '@shared/types';
import { projectTrustedCode } from '@shared/types/project';
import { snapshotBuiltinOccupancyTools } from '../../agent/builtinOccupancy';
import {
  deleteCustomWorkflowPreset,
  listBuiltinWorkflowPresets,
  listCustomWorkflowPresets,
  listWorkflowPresets,
  parseWorkflowPresetDraft,
  readCustomWorkflowPreset,
  saveCustomWorkflowPreset,
  workflowPresetRoots,
} from '../../agent/workflowPresets';
import {
  agentDataDir,
  customWorkflowPresetDir,
  menuPluginSkillPaths,
  menuPluginWorkflowPaths,
  readSettingsState,
} from '../services/agentHost';
import {
  instructionReader,
  occupancyForBuiltinTools,
  occupancyForInstructions,
  occupancyForMcp,
  occupancyForSkills,
  parseOccupancyIds,
} from '../services/assetOccupancy';
import { collectAssetImport, scanLocalAssets } from '../services/assetScan';
import { listProjectSkills, listSkillsAt } from '../services/assetScan/skills';
import { resolveLocalCwdForBrowser } from '../services/browserFileRoot';
import { listInstalledPluginInfo } from '../services/claudePlugins';
import {
  deleteInstruction,
  readInstruction,
  writeInstruction,
  writeInstructionSource,
} from '../services/instructionStore';
import { listMcpOccupancyTools } from '../services/mcpOccupancy';
import { getMcpToolCatalog } from '../services/mcpToolCatalog';
import { readSystemPrompt, writeSystemPrompt } from '../services/systemPromptStore';
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

  ipcMain.handle(IPC_CHANNELS.PLUGINS_LIST_INSTALLED, () => listInstalledPluginInfo());

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

  ipcMain.handle(
    IPC_CHANNELS.ASSETS_LIST_PROJECT_SKILLS,
    (_event, cwd: unknown, presetId: unknown) => {
      const agentDir = path.join(agentDataDir(), 'pi-agent');
      // 插件 skill 只在 spawn 时进会话命令；新对话发送前按所选预设预览，与 spawn 同口径
      const plugin = listSkillsAt(
        menuPluginSkillPaths(typeof presetId === 'string' && presetId ? presetId : undefined),
        agentDir
      );
      if (typeof cwd !== 'string' || !cwd) return plugin;
      // 与 spawn 同一来源读开关、agentDir 与项目信任：菜单预览与实际注入的 skill 集合保持一致
      const state = readSettingsState();
      const projects: unknown[] = Array.isArray(state?.projects) ? state.projects : [];
      const project = projects.find(
        (entry): entry is { id: string } =>
          Boolean(entry) &&
          typeof entry === 'object' &&
          (entry as { path?: unknown }).path === cwd &&
          typeof (entry as { id?: unknown }).id === 'string'
      );
      return listProjectSkills(cwd, {
        agentDir,
        trustedProjectCode: projectTrustedCode(projects, project?.id),
        includeHarness: state?.loadHarnessAssets === true,
      })
        .catch((error: unknown) => {
          console.error('[assets] list project skills failed:', error);
          return [];
        })
        .then((local) => [...plugin, ...local]);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.ASSETS_LIST_WORKFLOW_PRESETS,
    (_event, conversationId: unknown, presetId: unknown) => {
      if (typeof conversationId !== 'string' || !conversationId) return [];
      // 与 worker 执行同口径：本地会话含项目根（worktree 感知），远程只列设置、全局、插件与内置
      const cwd = resolveLocalCwdForBrowser(conversationId) ?? undefined;
      const pluginFiles = menuPluginWorkflowPaths(
        typeof presetId === 'string' && presetId ? presetId : undefined
      );
      // 禁用的内置预设由侧边栏按设置即时过滤，worker 执行时再拦
      return listWorkflowPresets(
        workflowPresetRoots(cwd, { customDir: customWorkflowPresetDir(), pluginFiles })
      );
    }
  );

  // 设置页：自定义 + 全部内置（含已禁用，开关状态在渲染侧设置里）
  ipcMain.handle(IPC_CHANNELS.WORKFLOW_PRESETS_LIST, () => [
    ...listCustomWorkflowPresets(customWorkflowPresetDir()),
    ...listBuiltinWorkflowPresets(),
  ]);

  ipcMain.handle(IPC_CHANNELS.WORKFLOW_PRESETS_READ, (_event, id: unknown) =>
    typeof id === 'string' ? readCustomWorkflowPreset(customWorkflowPresetDir(), id) : null
  );

  ipcMain.handle(IPC_CHANNELS.WORKFLOW_PRESETS_SAVE, (_event, draft: unknown, id: unknown) => {
    const parsed = parseWorkflowPresetDraft(draft);
    if (!parsed || (id !== undefined && typeof id !== 'string')) {
      return { ok: false, error: 'Invalid workflow preset' };
    }
    return saveCustomWorkflowPreset(customWorkflowPresetDir(), parsed, id);
  });

  ipcMain.handle(IPC_CHANNELS.WORKFLOW_PRESETS_DELETE, (_event, id: unknown) =>
    typeof id === 'string' ? deleteCustomWorkflowPreset(customWorkflowPresetDir(), id) : false
  );

  ipcMain.handle(IPC_CHANNELS.ASSETS_SKILL_OCCUPANCY, (_event, ids: unknown) =>
    occupancyForSkills(parseOccupancyIds(ids), asSkills(settingsState().skills))
  );

  ipcMain.handle(IPC_CHANNELS.ASSETS_INSTRUCTION_OCCUPANCY, (_event, ids: unknown) =>
    occupancyForInstructions(
      parseOccupancyIds(ids),
      instructionReader(asInstructions(settingsState().instructions), readInstruction)
    )
  );

  ipcMain.handle(IPC_CHANNELS.ASSETS_MCP_OCCUPANCY, (_event, ids: unknown) => {
    const servers = asMcp(settingsState().mcpServers);
    getMcpToolCatalog().retain(servers.map((server) => server.id));
    return occupancyForMcp(parseOccupancyIds(ids), servers, listMcpOccupancyTools);
  });

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

  ipcMain.handle(IPC_CHANNELS.PRESETS_SYSTEM_PROMPT_READ, (_event, id: unknown) => {
    if (id !== undefined && typeof id !== 'string') {
      return { ok: false, content: '', error: 'Invalid id' };
    }
    return readSystemPrompt(id);
  });

  ipcMain.handle(
    IPC_CHANNELS.PRESETS_SYSTEM_PROMPT_WRITE,
    (_event, id: unknown, content: unknown) => {
      if (typeof id !== 'string' || typeof content !== 'string') {
        return { ok: false, error: 'Invalid arguments' };
      }
      return writeSystemPrompt(id, content);
    }
  );

  ipcMain.handle(IPC_CHANNELS.PRESETS_FETCH_IMPORT, (_event, url: unknown) =>
    fetchPresetImport(url)
  );
}
