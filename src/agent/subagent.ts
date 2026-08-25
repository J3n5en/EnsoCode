import type { AgentSession, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentTypeSpawnConfig, SubagentInfo } from '@shared/types/agent';

/** 进度事件节流 */
const UPDATE_INTERVAL_MS = 500;

export interface SubagentDeps {
  /** 创建子会话（supervisor 闭包：复用父的 runtime/model/工具组装,不含 task/todo） */
  createSubSession(agentType?: AgentTypeSpawnConfig): Promise<AgentSession>;
  /** 父会话模型 id（general 类型展示用） */
  modelId: string;
  /** 自定义 agent 类型表（空 = 仅 general） */
  agentTypes: AgentTypeSpawnConfig[];
  /** 进度/状态上报（覆盖式,按 id 幂等） */
  emitUpdate(agent: SubagentInfo): void;
}

/** 从 pi 会话消息取最后一条 assistant 文本 */
function lastAssistantText(session: AgentSession): string {
  const messages = session.messages as { role?: string; content?: unknown }[];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'assistant') continue;
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const text = content
        .map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
        .join('');
      if (text.trim()) return text;
    }
  }
  return '';
}

let counter = 0;

/**
 * task 工具：把独立子任务委派给同 worker 内的子会话（隔离上下文,可并行）。
 * 父会话 abort 经 signal 传播终止子会话。
 */
export function createSubagentTool(deps: SubagentDeps): ToolDefinition {
  const typeList = deps.agentTypes
    .map(
      (type) =>
        `"${type.name}" — ${type.description || 'custom agent'}` +
        `${type.model ? ` (model: ${type.model.modelId})` : ''}${type.tools === 'readonly' ? ' [read-only tools]' : ''}`
    )
    .join('; ');
  const typeParam =
    deps.agentTypes.length > 0
      ? {
          agent_type: {
            type: 'string',
            description: `Agent type to use. Available: ${typeList}. Omit for a general agent using the session model.`,
          },
        }
      : {};
  return {
    name: 'subagent',
    label: 'Subagent',
    description:
      'Delegate a self-contained task to a subagent that runs in an isolated context with its own tools ' +
      '(read/bash/edit/write/MCP). Returns the subagent final report as the tool result. ' +
      'Use for parallelizable or context-heavy subtasks (research a module, implement an isolated change); ' +
      'multiple task calls in one message run in parallel. ' +
      'The subagent cannot ask you questions — include all needed context in the prompt.' +
      (deps.agentTypes.length > 0 ? ` Available agent types: ${typeList}.` : ''),
    promptSnippet:
      'subagent: delegate a self-contained subtask to a parallel subagent (isolated context); ' +
      'give it a complete prompt and it returns a final report; ' +
      'multiple subagent calls in one message run in parallel',
    parameters: {
      type: 'object',
      properties: {
        ...typeParam,
        description: {
          type: 'string',
          description: 'Short (3-8 words) label of the subtask, shown in the UI',
        },
        prompt: {
          type: 'string',
          description: 'Full task instructions for the subagent, self-contained',
        },
      },
      required: ['description', 'prompt'],
    } as unknown as ToolDefinition['parameters'],
    async execute(_toolCallId, params, signal) {
      const {
        description = '',
        prompt = '',
        agent_type: agentTypeName,
      } = params as { description?: string; prompt?: string; agent_type?: string };
      if (!prompt.trim()) throw new Error('task prompt is required');
      const agentType = agentTypeName
        ? deps.agentTypes.find((type) => type.name === agentTypeName)
        : undefined;
      if (agentTypeName && !agentType) {
        throw new Error(
          `unknown agent_type "${agentTypeName}". Available: [${deps.agentTypes.map((t) => t.name).join(', ')}] or omit for general.`
        );
      }
      const id = `agent-${++counter}-${Date.now().toString(36)}`;
      const info: SubagentInfo = {
        id,
        description: description || prompt.slice(0, 40),
        status: 'running',
        steps: 0,
        currentActivity: 'starting…',
        modelId: agentType?.model?.modelId ?? deps.modelId,
        startedAt: Date.now(),
      };
      deps.emitUpdate({ ...info });

      const session = await deps.createSubSession(agentType);
      let dirty = false;
      const timer = setInterval(() => {
        if (!dirty) return;
        dirty = false;
        deps.emitUpdate({ ...info });
      }, UPDATE_INTERVAL_MS);
      const unsubscribe = session.subscribe((event) => {
        if (event.type === 'message_start') {
          const role = (event.message as { role?: string }).role;
          if (role === 'assistant') {
            info.steps += 1;
            info.currentActivity = 'thinking…';
            dirty = true;
          }
        } else if (event.type === 'message_end') {
          const usage = (event.message as { usage?: { output?: number } }).usage;
          if (typeof usage?.output === 'number') {
            info.outputTokens = (info.outputTokens ?? 0) + usage.output;
            dirty = true;
          }
        } else if (event.type === 'tool_execution_start') {
          const args = event.args as Record<string, unknown> | undefined;
          const summary =
            typeof args?.command === 'string'
              ? args.command
              : typeof args?.path === 'string'
                ? args.path
                : '';
          info.currentActivity = `${event.toolName} ${summary}`.trim().slice(0, 80);
          dirty = true;
        }
      });
      const onAbort = () => void session.abort();
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        const fullPrompt = agentType?.systemPrompt
          ? `<role>\n${agentType.systemPrompt}\n</role>\n\n${prompt}`
          : prompt;
        await session.prompt(fullPrompt);
        const result = lastAssistantText(session);
        info.status = signal?.aborted ? 'failed' : 'done';
        info.resultText = result;
        info.currentActivity = '';
        deps.emitUpdate({ ...info });
        if (signal?.aborted) throw new Error('Subagent aborted');
        return {
          content: [{ type: 'text', text: result || '(subagent produced no output)' }],
          details: { modelId: info.modelId, outputTokens: info.outputTokens, steps: info.steps },
        };
      } catch (error) {
        info.status = 'failed';
        info.currentActivity = '';
        deps.emitUpdate({ ...info });
        throw error;
      } finally {
        clearInterval(timer);
        unsubscribe();
        signal?.removeEventListener('abort', onAbort);
        session.dispose();
      }
    },
  };
}
