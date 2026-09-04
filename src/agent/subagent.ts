import type { AgentSession, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { positiveContextWindow } from '@shared/modelCatalog';
import type {
  AgentTypeSpawnConfig,
  SpawnModelConfig,
  SubagentInfo,
  SubagentModelOption,
} from '@shared/types/agent';
import {
  CHILD_THINKING_LEVELS,
  type ChildThinkingLevel,
  resolveChildThinkingInput,
} from './childReasoning';
import { runFooter } from './runFooter';
import { collectStructuredYield, type JsonSchema } from './structuredYield';

/** 进度事件节流 */
const UPDATE_INTERVAL_MS = 500;
/** 异步完成通知里的报告上限 */
const NOTIFY_LIMIT = 1500;

export interface SubagentDeps {
  /** 创建子会话（supervisor 闭包：复用父的 runtime/model/工具组装,不含 task/todo） */
  createSubSession(
    agentType?: AgentTypeSpawnConfig,
    modelOverride?: SpawnModelConfig,
    thinking?: ChildThinkingLevel
  ): Promise<AgentSession>;
  /** 父会话模型 id（general 类型展示用） */
  modelId: string;
  /** 自定义 agent 类型表（空 = 仅 general） */
  agentTypes: AgentTypeSpawnConfig[];
  /** 模型中心勾选的子代理可选模型（空 = 不暴露 model 参数） */
  models: SubagentModelOption[];
  /** 进度/状态上报（覆盖式,按 id 幂等） */
  emitUpdate(agent: SubagentInfo): void;
  /** gate 验收:在会话 cwd 跑命令,返回 PASSED/FAILED 文本 */
  runGate(gate: string): Promise<string>;
  /** 异步模式完成时回传报告(running 搭车/轮末冲刷/idle 唤醒由 notifier 决定) */
  notify(text: string, urgent?: boolean): void;
  /** 结构化 yield 登记，供父会话 read agent://id */
  storeYield?(id: string, value: unknown): void;
}

/** 从 pi 会话消息取最后一条 assistant 文本 */
export function lastAssistantText(session: AgentSession): string {
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

function asJsonSchema(value: unknown): JsonSchema | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as JsonSchema;
}

let counter = 0;

/** 活动历史追加,capped 防内存/IPC 膨胀 */
function pushLog(info: SubagentInfo, line: string): void {
  if (!info.activityLog) info.activityLog = [];
  const log = info.activityLog;
  log.push(line);
  if (log.length > 200) log.splice(0, log.length - 200);
}

/**
 * task 工具：把独立子任务委派给同 worker 内的子会话（隔离上下文,可并行）。
 * 父会话 abort 经 signal 传播终止子会话。
 */
export function createSubagentTool(deps: SubagentDeps): ToolDefinition {
  const typeList = deps.agentTypes
    .map(
      (type) =>
        `"${type.name}" — ${type.description || 'custom agent'}` +
        `${type.allowModelOverride ? ' [custom model required]' : type.model ? ` (model: ${type.model.modelId})` : ' (follows conversation model)'}` +
        `${type.tools === 'readonly' ? ' [read-only tools]' : ''}`
    )
    .join('; ');
  const modelNames = deps.models.map((option) => option.name);
  const modelList = deps.models
    .map((option) => option.name + (option.description ? ` (${option.description})` : ''))
    .join('; ');
  const thinkingParam = {
    thinking: {
      type: 'string',
      enum: [...CHILD_THINKING_LEVELS],
      description:
        'Thinking effort for this run, same as /thinking ' +
        `(${CHILD_THINKING_LEVELS.join('/')}). ` +
        'Omit to use the selected model preset or inherit the conversation. ' +
        'You can also append a suffix on model, e.g. OpenAI/gpt-cheap:high.',
    },
  };
  const modelParam =
    deps.models.length > 0
      ? {
          model: {
            type: 'string',
            description:
              `Model override for this subagent: ${modelList}. ` +
              'Pick the cheapest model that fits the subtask. ' +
              'Required for agent_type marked [custom model required]; omit only when the type follows the conversation or uses a fixed model. ' +
              'Append :off/:minimal/:low/:medium/:high/:xhigh/:max to set thinking for this run.',
          },
        }
      : {};
  const typeParam =
    deps.agentTypes.length > 0
      ? {
          agent_type: {
            type: 'string',
            description: `Agent type to use. Available: ${typeList}. Omit for a general agent using the session model.`,
          },
        }
      : {};
  const builtinRoleHints: Record<string, string> = {
    scout: 'scout for recon/reading',
    worker: 'worker for an isolated code change',
    reviewer: 'reviewer after a sizeable change',
  };
  const roleHints = deps.agentTypes
    .map((type) => builtinRoleHints[type.name])
    .filter((hint): hint is string => hint !== undefined);
  const requiredPickTypes = deps.agentTypes
    .filter((type) => type.allowModelOverride)
    .map((type) => type.name);
  return {
    name: 'subagent',
    label: 'Subagent',
    description:
      'Delegate a self-contained task to a subagent that runs in an isolated context with its own tools ' +
      '(read/bash/edit/write/MCP). Returns the subagent final report as the tool result. ' +
      'Default choice for ONE-SHOT independent work (recon a module, implement an isolated change); ' +
      'multiple subagent calls in one message run in parallel. ' +
      'If the result will be acted on and re-checked (review → fix → re-review, test → fix → retest), ' +
      'use coworker instead — a subagent is disposed after its report and cannot see your fix. ' +
      'The subagent cannot ask you questions — include all needed context in the prompt. ' +
      'Pass wait:false for long tasks to keep working — the final report is delivered to you ' +
      'automatically when it finishes (and the parent abort no longer kills it). ' +
      (deps.agentTypes.length > 0 ? ` Available agent types: ${typeList}.` : ''),
    promptSnippet:
      'subagent: delegate one-shot subtasks by default — hand any independent subtask to a subagent (isolated context) ' +
      'with a complete prompt and get a final report back; anything that may loop (review/verify → fix → re-check) goes to coworker; ' +
      'multiple subagent calls in one message run in parallel' +
      (deps.agentTypes.length > 0
        ? `; agent_type options: ${deps.agentTypes
            .map((type) => `${type.name} (${type.description || 'custom'})`)
            .join(', ')} — pick the cheapest type that fits the subtask`
        : '') +
      (deps.models.length > 0
        ? '; a model parameter lets you pick a cheaper/stronger model per subtask — required for [custom model required] types, otherwise omit to inherit'
        : ''),
    promptGuidelines: [
      'Delegate by default: when a request has 2+ independent lines of work (explore module A / change B / verify C), ' +
        'dispatch them as parallel subagent calls in the same message instead of doing them serially yourself. ' +
        'Searching the whole repo yourself before acting is an anti-pattern when a subagent could do the recon',
      ...(roleHints.length > 0 ? [`Pick agent_type by role: ${roleHints.join('; ')}`] : []),
      ...(requiredPickTypes.length > 0 && modelNames.length > 0
        ? [
            `When using agent_type marked [custom model required] (${requiredPickTypes.join(', ')}), always pass model on the first call — omitting it fails, do not retry without model. Available: ${modelNames.join(', ')}`,
          ]
        : []),
    ],
    parameters: {
      type: 'object',
      properties: {
        ...typeParam,
        ...modelParam,
        ...thinkingParam,
        description: {
          type: 'string',
          description: 'Short (3-8 words) label of the subtask, shown in the UI',
        },
        prompt: {
          type: 'string',
          description: 'Full task instructions for the subagent, self-contained',
        },
        gate: {
          type: 'string',
          description:
            'Shell command to verify the work after the subagent finishes ' +
            '(run in the workspace; exit code decides pass/fail), e.g. "pnpm test"',
        },
        wait: {
          type: 'boolean',
          description:
            'Default true: block until the report is ready. Pass false to dispatch and keep ' +
            'working — the report is delivered to you when done',
        },
        schema: {
          type: 'object',
          description:
            'Optional JSON Schema. The subagent final reply must be JSON matching this schema; ' +
            'read it later via agent://<id> or agent://<id>?q=/pointer',
        },
      },
      required: ['description', 'prompt'],
    } as unknown as ToolDefinition['parameters'],
    async execute(_toolCallId, params, signal) {
      const {
        description = '',
        prompt = '',
        agent_type: agentTypeName,
        model: modelName,
        thinking: thinkingRaw,
        gate,
        wait = true,
        schema: schemaRaw,
      } = params as {
        description?: string;
        prompt?: string;
        agent_type?: string;
        model?: string;
        thinking?: string;
        gate?: string;
        wait?: boolean;
        schema?: unknown;
      };
      const schema = asJsonSchema(schemaRaw);
      if (!prompt.trim()) throw new Error('task prompt is required');
      const agentType = agentTypeName
        ? deps.agentTypes.find((type) => type.name === agentTypeName)
        : undefined;
      if (agentTypeName && !agentType) {
        throw new Error(
          `unknown agent_type "${agentTypeName}". Available: [${deps.agentTypes.map((t) => t.name).join(', ')}] or omit for general.`
        );
      }
      const { modelName: resolvedModelName, thinking } = resolveChildThinkingInput(
        modelName,
        thinkingRaw
      );
      const modelOption = resolvedModelName
        ? deps.models.find((option) => option.name === resolvedModelName)
        : undefined;
      if (resolvedModelName && !modelOption) {
        throw new Error(
          `unknown model "${resolvedModelName}". Available: [${modelNames.join(', ')}].`
        );
      }
      if (agentType && agentType.allowModelOverride === false && resolvedModelName) {
        throw new Error(
          `agent_type "${agentType.name}" does not allow custom model selection (it is locked to ${agentType.model ? agentType.model.modelId : 'conversation model'}).`
        );
      }
      if (agentType?.allowModelOverride && !resolvedModelName) {
        throw new Error(
          `agent_type "${agentType.name}" requires a model. Available: [${modelNames.join(', ')}]`
        );
      }
      const id = `agent-${++counter}-${Date.now().toString(36)}`;
      const info: SubagentInfo = {
        id,
        description: description || prompt.slice(0, 40),
        status: 'running',
        steps: 0,
        currentActivity: 'starting…',
        activityLog: [],
        modelId: modelOption?.config.modelId ?? agentType?.model?.modelId ?? deps.modelId,
        ...(agentType ? { agentType: agentType.name } : {}),
        startedAt: Date.now(),
      };
      deps.emitUpdate({ ...info });

      const session = await deps.createSubSession(agentType, modelOption?.config, thinking);
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
          const message = event.message as {
            role?: string;
            usage?: { output?: number };
            content?: unknown;
          };
          if (typeof message.usage?.output === 'number') {
            info.outputTokens = (info.outputTokens ?? 0) + message.usage.output;
            dirty = true;
          }
          // 子代理阶段性文本进历史（首行,截断）
          if (message.role === 'assistant' && Array.isArray(message.content)) {
            const text = message.content
              .map((part) =>
                (part as { type?: string; text?: string }).type === 'text'
                  ? ((part as { text?: string }).text ?? '')
                  : ''
              )
              .join('')
              .trim();
            if (text) pushLog(info, text.slice(0, 200));
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
          pushLog(info, `→ ${event.toolName} ${summary}`.trim().slice(0, 160));
          dirty = true;
        }
      });
      // 阻塞模式下父 abort 连坐杀子;异步模式派发后独立跑,不受父 abort 影响
      const onAbort = () => void session.abort();
      if (wait) signal?.addEventListener('abort', onAbort, { once: true });

      let footer = '';
      const run = async (): Promise<string> => {
        const rolePrefix = agentType?.systemPrompt
          ? `<role>\n${agentType.systemPrompt}\n</role>\n\n`
          : '';
        const schemaSuffix = schema
          ? `\n\nReturn your final answer as JSON only, matching this schema:\n${JSON.stringify(schema)}`
          : '';
        const fullPrompt = `${rolePrefix}${prompt}${schemaSuffix}`;
        try {
          await session.prompt(fullPrompt);
          if (schema) {
            const collected = await collectStructuredYield({
              text: lastAssistantText(session),
              schema,
              prompt: (nudge) => session.prompt(nudge),
              reread: () => lastAssistantText(session),
            });
            deps.storeYield?.(id, collected.value);
          }
          let result = lastAssistantText(session) || '(subagent produced no output)';
          // 脚注先于 gate:工具分布/耗时是子代理自身的事实,gate 是父的验收
          footer = runFooter({
            messages: session.messages,
            label: agentType?.name ?? 'general',
            modelId: info.modelId ?? deps.modelId,
            elapsedMs: Date.now() - info.startedAt,
            contextWindow: positiveContextWindow(session.model),
          });
          result += `\n\n${footer}`;
          // gate 验收:退出码说了算,不信子代理自称完成
          if (gate && !(wait && signal?.aborted)) {
            result += `\n\n${await deps.runGate(gate)}`;
          }
          const aborted = wait && signal?.aborted;
          info.status = aborted ? 'failed' : 'done';
          info.resultText = result;
          info.currentActivity = '';
          deps.emitUpdate({ ...info });
          if (aborted) throw new Error('Subagent aborted');
          return result;
        } catch (error) {
          info.status = 'failed';
          info.currentActivity = '';
          deps.emitUpdate({ ...info });
          throw error;
        } finally {
          clearInterval(timer);
          unsubscribe();
          if (wait) signal?.removeEventListener('abort', onAbort);
          session.dispose();
        }
      };

      if (!wait) {
        // 派发即返回;完成后报告经通知回传(失败立即,成功合并投递)
        void run()
          .then((result) => {
            // 截断也要保住脚注:它是主 agent 判断该不该信这份报告的依据
            const brief =
              result.length > NOTIFY_LIMIT
                ? `${result.slice(0, NOTIFY_LIMIT)}\n…(truncated)\n${footer}`
                : result;
            deps.notify(`Subagent "${info.description}" finished:\n${brief}`, false);
          })
          .catch((error) => {
            deps.notify(
              `Subagent "${info.description}" FAILED: ${error instanceof Error ? error.message : String(error)}`,
              true
            );
          });
        return {
          content: [
            {
              type: 'text',
              text:
                `(dispatched subagent "${info.description}" [${id}] — the report will be delivered ` +
                'to you when it finishes; keep working or return to the user meanwhile)',
            },
          ],
          details: { modelId: info.modelId },
        };
      }

      const result = await run();
      return {
        content: [{ type: 'text', text: result }],
        details: { modelId: info.modelId, outputTokens: info.outputTokens, steps: info.steps },
      };
    },
  };
}
