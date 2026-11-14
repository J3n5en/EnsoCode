import { randomUUID } from 'node:crypto';
import type { SessionIdentity } from '@shared/builtinAgents';
import type { PluginAgentRunEvent } from '@shared/extensionPlugins/protocol';
import type { AgentCommand, AgentWorkerEvent, SpawnModelConfig } from '@shared/types/agent';

type PluginAgentCommand = Extract<
  AgentCommand,
  { type: 'plugin-agent-run' | 'plugin-agent-cancel' }
>;

export interface PluginAgentRunInput {
  prompt: string;
  systemPrompt?: string;
  context: 'conversation' | 'fork' | 'none';
  timeoutMs: number;
  /** 缺省跟随发起会话的模型 */
  model?: SpawnModelConfig;
}

/** Main 侧插件代理表：在 worker 里跑，事件按 requestId 回给发起方，终态后清掉 */
export class PluginAgentRuns {
  private readonly runs = new Map<string, (event: PluginAgentRunEvent) => void>();

  constructor(
    /** 发给 worker；worker 不可用返回 false */
    private readonly post: (command: PluginAgentCommand) => boolean
  ) {}

  start(
    identity: SessionIdentity,
    input: PluginAgentRunInput,
    onEvent: (event: PluginAgentRunEvent) => void
  ): { ok: true; cancel(): void } | { ok: false; error: string } {
    const requestId = randomUUID();
    this.runs.set(requestId, onEvent);
    const { systemPrompt, model, ...rest } = input;
    const sent = this.post({
      type: 'plugin-agent-run',
      requestId,
      identity,
      ...rest,
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(model ? { model } : {}),
    });
    if (!sent) {
      this.runs.delete(requestId);
      return { ok: false, error: '无法启动代理' };
    }
    return {
      ok: true,
      cancel: () => {
        if (this.runs.has(requestId)) this.post({ type: 'plugin-agent-cancel', requestId });
      },
    };
  }

  settle(event: AgentWorkerEvent): boolean {
    if (event.type !== 'plugin-agent-event') return false;
    const listener = this.runs.get(event.requestId);
    if (!listener) return true;
    if (event.event.type === 'end') this.runs.delete(event.requestId);
    listener(event.event);
    return true;
  }

  failAll(message: string): void {
    const listeners = [...this.runs.values()];
    this.runs.clear();
    for (const listener of listeners) listener({ type: 'end', ok: false, error: message });
  }
}
