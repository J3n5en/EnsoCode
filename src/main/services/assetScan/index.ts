import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AssetCandidate,
  AssetSourceId,
  AssetSourceReport,
  CollectedAsset,
  LocalAssetScanResult,
} from '@shared/types';
import { readSettings } from '../../ipc/settings';
import { readCcSwitchMcp, readCcSwitchPrompts, readCcSwitchSkills } from './ccSwitch';
import { type DiscoveredInstruction, readInstructionFiles } from './instructions';
import { type DiscoveredMcpServer, readClaudeMcp, readCodexMcp, readJsonMcp } from './mcp';
import { type DiscoveredSkill, displayPath, readPluginSkills, readSkillsRoot } from './skills';

const HOME = os.homedir();
const home = (...parts: string[]) => path.join(HOME, ...parts);

const SOURCE_NAMES: Record<AssetSourceId, string> = {
  'claude-code': 'Claude Code',
  'claude-plugins': 'Claude Code 插件',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  grok: 'Grok CLI',
  factory: 'Factory',
  opencode: 'opencode',
  'cc-switch': 'CC Switch',
};

interface SourceSpec {
  /** 用于判断来源是否存在的路径 */
  probe: string;
  readSkills?: () => DiscoveredSkill[];
  readMcp?: () => DiscoveredMcpServer[];
  readInstructions?: () => DiscoveredInstruction[];
}

function claudeDesktopConfig(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? home('AppData', 'Roaming');
    return path.join(appData, 'Claude', 'claude_desktop_config.json');
  }
  return home('Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
}

function sourceSpec(sourceId: AssetSourceId): SourceSpec {
  switch (sourceId) {
    case 'claude-code': {
      const dir = home('.claude');
      const skillsRoot = path.join(dir, 'skills');
      const mcpFile = home('.claude.json');
      return {
        probe: fs.existsSync(dir) ? dir : mcpFile,
        readSkills: () => readSkillsRoot(skillsRoot, SOURCE_NAMES['claude-code']),
        readMcp: () => (fs.existsSync(mcpFile) ? readClaudeMcp(mcpFile) : []),
        readInstructions: () => readInstructionFiles(dir, displayPath),
      };
    }
    case 'claude-plugins': {
      const file = home('.claude', 'plugins', 'installed_plugins.json');
      return { probe: file, readSkills: () => readPluginSkills(file) };
    }
    case 'claude-desktop': {
      const file = claudeDesktopConfig();
      return { probe: file, readMcp: () => readJsonMcp(file) };
    }
    case 'codex': {
      const dir = home('.codex');
      const configFile = path.join(dir, 'config.toml');
      return {
        probe: dir,
        readSkills: () => readSkillsRoot(path.join(dir, 'skills'), SOURCE_NAMES.codex),
        readMcp: () => (fs.existsSync(configFile) ? readCodexMcp(configFile) : []),
        readInstructions: () => readInstructionFiles(dir, displayPath),
      };
    }
    case 'cursor': {
      const dir = home('.cursor');
      const mcpFile = path.join(dir, 'mcp.json');
      return {
        probe: dir,
        readSkills: () => readSkillsRoot(path.join(dir, 'skills'), SOURCE_NAMES.cursor),
        readMcp: () => (fs.existsSync(mcpFile) ? readJsonMcp(mcpFile) : []),
        readInstructions: () => readInstructionFiles(dir, displayPath),
      };
    }
    case 'gemini': {
      const dir = home('.gemini');
      return { probe: dir, readInstructions: () => readInstructionFiles(dir) };
    }
    case 'grok': {
      const dir = home('.grok');
      return { probe: dir, readInstructions: () => readInstructionFiles(dir) };
    }
    case 'factory': {
      const dir = home('.factory');
      return { probe: dir, readInstructions: () => readInstructionFiles(dir) };
    }
    case 'opencode': {
      const dir = home('.config', 'opencode');
      return { probe: dir, readInstructions: () => readInstructionFiles(dir, displayPath) };
    }
    case 'cc-switch': {
      const dbFile = home('.cc-switch', 'cc-switch.db');
      return {
        probe: dbFile,
        readSkills: () => readCcSwitchSkills(dbFile, SOURCE_NAMES['cc-switch']),
        readMcp: () => readCcSwitchMcp(dbFile),
        readInstructions: () => readCcSwitchPrompts(dbFile),
      };
    }
  }
}

const skillKey = (target: string): string => path.resolve(target);

/** 技能以名称为标识：同名技能无法共存，跨来源的同一技能应视为重复 */
const skillNameKey = (name: string): string => name.trim().toLowerCase();

const mcpKey = (server: DiscoveredMcpServer): string =>
  server.url
    ? `url::${server.url.replace(/\/+$/, '')}`
    : `cmd::${server.command} ${(server.args ?? []).join(' ')}`.trim();

/** 读取 settings.json 中已登记的技能与 MCP 指纹 */
function existingKeys(): {
  skillPaths: Set<string>;
  skillNames: Set<string>;
  mcp: Set<string>;
  instructionPaths: Set<string>;
} {
  const settings = readSettings();
  const state = (
    settings?.['enso-settings'] as
      | { state?: { skills?: unknown; mcpServers?: unknown; instructions?: unknown } }
      | undefined
  )?.state;

  const skills = Array.isArray(state?.skills) ? state.skills : [];
  const mcpServers = Array.isArray(state?.mcpServers) ? state.mcpServers : [];
  const instructions = Array.isArray(state?.instructions) ? state.instructions : [];

  return {
    skillPaths: new Set(
      skills
        .map((item) => (item as { path?: string }).path)
        .filter((value): value is string => Boolean(value))
        .map(skillKey)
    ),
    skillNames: new Set(
      skills
        .map((item) => (item as { name?: string }).name)
        .filter((value): value is string => Boolean(value))
        .map(skillNameKey)
    ),
    mcp: new Set(mcpServers.map((item) => mcpKey(item as DiscoveredMcpServer))),
    instructionPaths: new Set(
      instructions
        .map((item) => (item as { sourcePath?: string }).sourcePath)
        .filter((value): value is string => Boolean(value))
        .map((value) => path.resolve(value))
    ),
  };
}

type Cached =
  | { kind: 'skill'; sourceId: AssetSourceId; skill: DiscoveredSkill }
  | { kind: 'mcp'; sourceId: AssetSourceId; server: DiscoveredMcpServer }
  | { kind: 'instruction'; sourceId: AssetSourceId; instruction: DiscoveredInstruction };

// 仅保留最近一次扫描，供确认导入时取回完整数据（含 env 明文）
let lastScan: { scanId: string; byId: Map<string, Cached> } | null = null;

export function scanLocalAssets(): LocalAssetScanResult {
  const known = existingKeys();
  const scanId = randomUUID();
  const byId = new Map<string, Cached>();
  const sources: AssetSourceReport[] = [];
  const candidates: AssetCandidate[] = [];
  // 本轮扫描内已出现过的技能名 / MCP 指纹，用于跨来源去重
  const seenSkillNames = new Set<string>();
  const seenMcpKeys = new Set<string>();
  // 指令文件按内容哈希去重：多家工具常共用同一份内容
  const seenInstructionHashes = new Set<string>();

  for (const sourceId of Object.keys(SOURCE_NAMES) as AssetSourceId[]) {
    const spec = sourceSpec(sourceId);
    const report: AssetSourceReport = {
      sourceId,
      sourceName: SOURCE_NAMES[sourceId],
      status: 'not-found',
      configPath: displayPath(spec.probe),
      skillCount: 0,
      mcpCount: 0,
      instructionCount: 0,
    };
    sources.push(report);

    if (!fs.existsSync(spec.probe)) continue;

    try {
      for (const skill of spec.readSkills?.() ?? []) {
        const id = randomUUID();
        const nameKey = skillNameKey(skill.name);
        const registered =
          known.skillNames.has(nameKey) || known.skillPaths.has(skillKey(skill.path));
        // 本轮更前面的来源已出现过同名技能
        const sameName = seenSkillNames.has(nameKey);
        seenSkillNames.add(nameKey);

        byId.set(id, { kind: 'skill', sourceId, skill });
        candidates.push({
          id,
          kind: 'skill',
          sourceId,
          groupName: skill.groupName,
          name: skill.name,
          description: skill.description,
          path: displayPath(skill.path),
          duplicated: registered || sameName,
          duplicateReason: registered ? 'registered' : sameName ? 'same-name' : undefined,
        });
        report.skillCount += 1;
      }

      for (const server of spec.readMcp?.() ?? []) {
        const id = randomUUID();
        const key = mcpKey(server);
        const registered = known.mcp.has(key);
        const sameContent = seenMcpKeys.has(key);
        seenMcpKeys.add(key);

        byId.set(id, { kind: 'mcp', sourceId, server });
        candidates.push({
          id,
          kind: 'mcp',
          sourceId,
          groupName: SOURCE_NAMES[sourceId],
          name: server.name,
          transport: server.transport,
          summary: server.url ?? [server.command, ...(server.args ?? [])].join(' ').trim(),
          envKeys: Object.keys(server.env ?? {}),
          duplicated: registered || sameContent,
          duplicateReason: registered ? 'registered' : sameContent ? 'same-content' : undefined,
        });
        report.mcpCount += 1;
      }

      for (const instruction of spec.readInstructions?.() ?? []) {
        const id = randomUUID();
        const registered = instruction.path
          ? known.instructionPaths.has(path.resolve(instruction.path))
          : false;
        const sameContent = seenInstructionHashes.has(instruction.hash);
        seenInstructionHashes.add(instruction.hash);

        byId.set(id, { kind: 'instruction', sourceId, instruction });
        candidates.push({
          id,
          kind: 'instruction',
          sourceId,
          groupName: SOURCE_NAMES[sourceId],
          name: instruction.name,
          location: instruction.location,
          bytes: instruction.bytes,
          duplicated: registered || sameContent,
          duplicateReason: registered ? 'registered' : sameContent ? 'same-content' : undefined,
        });
        report.instructionCount += 1;
      }

      report.status = 'found';
    } catch (error) {
      console.warn(`[AssetScan] Failed reading ${sourceId}:`, error);
      report.status = 'read-error';
    }
  }

  lastScan = { scanId, byId };
  return { scanId, sources, candidates };
}

export function collectAssetImport(scanId: string, candidateIds: string[]): CollectedAsset[] {
  if (!lastScan || lastScan.scanId !== scanId) return [];

  const seen = new Set<string>();
  const collected: CollectedAsset[] = [];

  for (const candidateId of candidateIds) {
    const cached = lastScan.byId.get(candidateId);
    if (!cached) continue;

    if (cached.kind === 'skill') {
      const key = `skill::${skillNameKey(cached.skill.name)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push({
        candidateId,
        kind: 'skill',
        name: cached.skill.name,
        description: cached.skill.description,
        path: cached.skill.path,
        source: cached.skill.groupName,
      });
    } else if (cached.kind === 'mcp') {
      const key = `mcp::${mcpKey(cached.server)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push({
        candidateId,
        kind: 'mcp',
        name: cached.server.name,
        transport: cached.server.transport,
        command: cached.server.command,
        args: cached.server.args,
        env: cached.server.env,
        url: cached.server.url,
        source: SOURCE_NAMES[cached.sourceId],
      });
    } else {
      const key = `instruction::${cached.instruction.hash}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push({
        candidateId,
        kind: 'instruction',
        name: cached.instruction.name,
        sourcePath: cached.instruction.path,
        // 无文件来源必须立即落成本地副本
        content: cached.instruction.path ? undefined : cached.instruction.content,
        bytes: cached.instruction.bytes,
        source: SOURCE_NAMES[cached.sourceId],
      });
    }
  }

  return collected;
}
