import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  type AgentCommand,
  type AgentSpawnRequest,
  type AttachedImage,
  type McpServerSpawnConfig,
  parseAgentWorkerEvent,
  type RendererAgentEvent,
  type SpawnModelConfig,
  type ThinkingLevel,
} from '@shared/types/agent';
import { DEFAULT_PRESET_ID, type Preset } from '@shared/types/assets';
import type { ModelProvider } from '@shared/types/llm';
import { app, type UtilityProcess, utilityProcess } from 'electron';
import { readSettings } from '../ipc/settings';
import { syncGlobalInstruction } from './instructionStore';

/** 管理 agent worker（utilityProcess）的生命周期与命令下发。故障域 A：一个 worker 装全部会话。 */
let worker: UtilityProcess | null = null;
let onEvent: ((event: RendererAgentEvent) => void) | null = null;

/** Main 收到 worker 事件 / worker 退出时的回调，由 IPC 层注册用于广播到窗口 */
export function setAgentEventListener(listener: (event: RendererAgentEvent) => void): void {
  onEvent = listener;
}

export function startAgentWorker(): void {
  if (worker) return;
  const child = utilityProcess.fork(path.join(import.meta.dirname, 'agent.js'), [], {
    serviceName: 'enso-agent-worker',
    env: {
      ...process.env,
      // pi 的全局目录与会话目录都收进 userData，不碰用户的 ~/.pi
      ENSO_AGENT_DATA_DIR: path.join(app.getPath('userData'), 'agent'),
    },
  });
  worker = child;

  child.on('message', (raw) => {
    const event = parseAgentWorkerEvent(raw);
    if (event) onEvent?.(event);
  });

  child.on('exit', () => {
    if (worker === child) worker = null;
    // worker 没了等于全部活会话终止；Renderer 收到后把所有会话标 failed
    onEvent?.({ type: 'worker-exited' });
  });
}

export function stopAgentWorker(): void {
  worker?.kill();
  worker = null;
}

function sendCommand(command: AgentCommand): { ok: boolean; error?: string } {
  if (!worker) return { ok: false, error: 'agent worker not running' };
  worker.postMessage(command);
  return { ok: true };
}

/** 从 settings 取 provider，补全 apiKey 组装 spawn 命令。apiKey 到此为止，不回 Renderer */
export function spawnSession(request: AgentSpawnRequest): { ok: boolean; error?: string } {
  const provider = findProvider(request.providerId);
  if (!provider) return { ok: false, error: `provider not found: ${request.providerId}` };
  // resume 的 jsonl 已被删除时 pi 会静默打开空会话（内容全空、不报错），历史会话打开一片空白。
  // 在此同步拦下，让 Renderer 经 IPC 返回值拿到明确错误
  if (request.resumeFile && !existsSync(request.resumeFile)) {
    return { ok: false, error: '会话文件已丢失，无法恢复历史' };
  }
  // 启用的指令文件（单主源）落到 pi agentDir 的 AGENTS.md，pi 会话自动读取；
  // 自定义预设则显式指定注入哪份（或不注入）
  const preset = resolvePreset(request.presetId);
  syncGlobalInstruction(preset ? { instructionId: preset.instructionId } : undefined);
  const model: SpawnModelConfig = {
    api: provider.api,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    modelId: request.modelId,
  };
  return sendCommand({
    type: 'spawn',
    sessionId: request.sessionId,
    cwd: request.cwd,
    model,
    ...(request.resumeFile ? { resumeFile: request.resumeFile } : {}),
    ...(request.reasoningEnabled ? { reasoningEnabled: true } : {}),
    ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
    ...(request.loadLocalSkills === false ? { loadLocalSkills: false } : {}),
    ...(() => {
      const skillPaths = enabledSkillPaths(preset);
      return skillPaths.length > 0 ? { skillPaths } : {};
    })(),
    ...(() => {
      const mcpServers = enabledMcpServers(preset);
      return mcpServers.length > 0 ? { mcpServers } : {};
    })(),
  });
}

/** 解析自定义预设；缺省 / default / 找不到（已删）都返回 undefined = 走 enabled 过滤 */
function resolvePreset(presetId?: string): Preset | undefined {
  if (!presetId || presetId === DEFAULT_PRESET_ID) return undefined;
  const state = readSettingsState();
  const presets = Array.isArray(state?.presets) ? (state.presets as Preset[]) : [];
  return presets.find((preset) => preset?.id === presetId);
}

/** 注入的 skill 目录：默认走 enabled 过滤；自定义预设按 id 集合（忽略条目 enabled） */
function enabledSkillPaths(preset?: Preset): string[] {
  const state = readSettingsState();
  const skills = Array.isArray(state?.skills)
    ? (state.skills as { id?: string; path?: string; enabled?: boolean }[])
    : [];
  const picked = preset
    ? skills.filter((skill) => skill.id && preset.skillIds.includes(skill.id))
    : skills.filter((skill) => skill.enabled !== false);
  return picked
    .filter((skill) => typeof skill.path === 'string' && skill.path)
    .map((skill) => skill.path as string);
}

/** 注入的 MCP server：默认走 enabled 过滤；自定义预设按 id 集合（忽略条目 enabled） */
function enabledMcpServers(preset?: Preset): McpServerSpawnConfig[] {
  const state = readSettingsState();
  const servers = Array.isArray(state?.mcpServers)
    ? (state.mcpServers as (McpServerSpawnConfig & { id?: string; enabled?: boolean })[])
    : [];
  const picked = preset
    ? servers.filter((server) => server.id && preset.mcpServerIds.includes(server.id))
    : servers.filter((server) => server.enabled !== false);
  return picked
    .filter((server) => server.name && server.transport)
    .map(({ name, transport, command, args, env, url }) => ({
      name,
      transport,
      ...(command ? { command } : {}),
      ...(args?.length ? { args } : {}),
      ...(env && Object.keys(env).length > 0 ? { env } : {}),
      ...(url ? { url } : {}),
    }));
}

export function setSessionThinking(
  sessionId: string,
  level: ThinkingLevel
): { ok: boolean; error?: string } {
  return sendCommand({ type: 'set-thinking', sessionId, level });
}

export function setSessionReasoning(
  sessionId: string,
  enabled: boolean,
  level?: ThinkingLevel
): { ok: boolean; error?: string } {
  return sendCommand({ type: 'set-reasoning', sessionId, enabled, ...(level ? { level } : {}) });
}

export function promptSession(
  sessionId: string,
  text: string,
  images?: AttachedImage[]
): { ok: boolean; error?: string } {
  return sendCommand({ type: 'prompt', sessionId, text, ...(images?.length ? { images } : {}) });
}

export function steerSession(
  sessionId: string,
  text: string,
  images?: AttachedImage[]
): { ok: boolean; error?: string } {
  return sendCommand({ type: 'steer', sessionId, text, ...(images?.length ? { images } : {}) });
}

export function abortSession(sessionId: string): { ok: boolean; error?: string } {
  return sendCommand({ type: 'abort', sessionId });
}

/** 请求 worker 全量投影快照，结果经 AGENT_EVENT 广播回来 */
export function requestSnapshot(): { ok: boolean; error?: string } {
  return sendCommand({ type: 'snapshot' });
}

function readSettingsState(): Record<string, unknown> | undefined {
  const settings = readSettings();
  return (settings?.['enso-settings'] as { state?: Record<string, unknown> } | undefined)?.state;
}

function findProvider(providerId: string): ModelProvider | null {
  const state = readSettingsState();
  const providers = Array.isArray(state?.providers) ? (state.providers as ModelProvider[]) : [];
  return providers.find((provider) => provider?.id === providerId) ?? null;
}
