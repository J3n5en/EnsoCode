import path from 'node:path';
import {
  type AgentCommand,
  type AgentSpawnRequest,
  type AttachedImage,
  parseAgentWorkerEvent,
  type RendererAgentEvent,
  type SpawnModelConfig,
} from '@shared/types/agent';
import type { ModelProvider } from '@shared/types/llm';
import { app, type UtilityProcess, utilityProcess } from 'electron';
import { readSettings } from '../ipc/settings';

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
  });
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

function findProvider(providerId: string): ModelProvider | null {
  const settings = readSettings();
  const state = (settings?.['enso-settings'] as { state?: { providers?: unknown } } | undefined)
    ?.state;
  const providers = Array.isArray(state?.providers) ? (state.providers as ModelProvider[]) : [];
  return providers.find((provider) => provider?.id === providerId) ?? null;
}
