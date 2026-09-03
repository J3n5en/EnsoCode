import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentTypeSpawnConfig, CoworkerInfo, SubagentModelOption } from '@shared/types/agent';

/** 回传主 agent 的结果上限,全文永远在 coworker tab 里 */
const RESULT_LIMIT = 4000;

export interface CoworkerSendOptions {
  signal?: AbortSignal;
  /** true = 阻塞至该轮结束返回结果;false(默认)= 投递即返回,完成后经通知回来 */
  wait?: boolean;
  /** 轮次完成后在会话 cwd 执行的验收命令,退出码即结论 */
  gate?: string;
}

export interface CoworkerToolDeps {
  agentTypes: AgentTypeSpawnConfig[];
  /** 模型中心勾选的子代理可选模型（空 = 不暴露 model 参数） */
  models: SubagentModelOption[];
  /** 雇佣:创建持久子会话并登记(不发首条消息)。modelName 仅 spawn 时生效 */
  spawn(name: string, agentTypeName?: string, modelName?: string): Promise<CoworkerInfo>;
  /** 发消息。wait=false 时立即返回投递回执,轮次完成后自动通知主 agent */
  send(name: string, message: string, opts?: CoworkerSendOptions): Promise<string>;
  list(): CoworkerInfo[];
  dismiss(name: string): Promise<void>;
}

const truncate = (text: string): string =>
  text.length > RESULT_LIMIT
    ? `${text.slice(0, RESULT_LIMIT)}\n…(truncated — full transcript in the coworker tab)`
    : text;

/**
 * coworker 工具:雇佣持久子代理(与一次性 subagent 相对)。
 * coworker 保有自己的完整上下文,可多轮 send 追问;用户在 tab 中旁观并可直接介入。
 */
export function createCoworkerTool(deps: CoworkerToolDeps): ToolDefinition {
  const typeList = deps.agentTypes.map((type) => type.name).join(', ');
  const modelNames = deps.models.map((option) => option.name);
  const modelList = deps.models
    .map((option) => option.name + (option.description ? ` (${option.description})` : ''))
    .join('; ');
  const modelParam =
    deps.models.length > 0
      ? {
          model: {
            type: 'string',
            description:
              `Model override for spawn: ${modelList}. ` +
              'Pick the cheapest model that fits the role; omit to inherit the default.',
          },
        }
      : {};
  return {
    name: 'coworker',
    label: 'Coworker',
    description:
      'Hire a persistent coworker agent that keeps its own context across multiple send calls. ' +
      'Unlike `subagent` (one-shot, disposed after a single report), a coworker stays alive: ' +
      'spawn it once with a role and initial task, then send follow-ups that build on everything it has seen. ' +
      'The user watches each coworker in its own tab and may reply there directly. ' +
      'Operations: spawn {name, agent_type?, task} / send {name, message} / list / dismiss {name}. ' +
      'spawn and send are ASYNC by default: they return immediately and you are notified automatically ' +
      'when the round completes — do NOT poll or wait idle; keep working or return to the user. ' +
      'Pass wait:true only when you must have the result before continuing. ' +
      'Optional gate: a shell command run after the round; its exit code verifies the work ' +
      '(e.g. "pnpm test"). Results are truncated; the full transcript lives in the coworker tab.' +
      (typeList ? ` Available agent types: ${typeList}.` : ''),
    promptSnippet:
      'coworker: hire a persistent named agent (own tab, own accumulating context, multi-round). ' +
      'Use subagent for self-contained one-shot subtasks; use coworker for multi-round work on the same ' +
      'accumulated context or when the user should watch and join. ' +
      'spawn/send are async by default — you get notified on completion, so never block waiting; ' +
      'pass wait:true only when the result is needed immediately. ' +
      'Verify delegated work with gate:"<command>" (exit code speaks, not the coworker). ' +
      'Coworkers cost resources while alive — dismiss them when done; prefer few with clear roles' +
      (deps.models.length > 0
        ? '. A model parameter on spawn lets you pick a cheaper/stronger model per role — see the tool schema for options'
        : ''),
    promptGuidelines: [
      'A coworker is multi-round by default: give it the role and the first step in spawn, then steer with send. ' +
        'A "finished a round" notice is not completion — reply with send to verify, correct, or ask for evidence; ' +
        'do not redo its work yourself and do not spawn a second coworker for the same role (reuse the name). ' +
        'When a coworker reaches you via message_main_agent, answer it with send. ' +
        "dismiss only when the role's goal is met or the user says stop",
    ],
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['spawn', 'send', 'list', 'dismiss'],
          description: 'spawn: hire + first task; send: follow-up; list: roster; dismiss: fire',
        },
        name: {
          type: 'string',
          description: 'Coworker name (short slug), required for spawn/send/dismiss',
        },
        agent_type: {
          type: 'string',
          description: `Agent type for spawn${typeList ? ` (${typeList})` : ''}; omit for general`,
        },
        ...modelParam,
        task: {
          type: 'string',
          description: 'First-round task for spawn (role + first step); continue with send',
        },
        message: { type: 'string', description: 'Message for send' },
        wait: {
          type: 'boolean',
          description:
            'Block until the round completes and return the result inline (default false: ' +
            'return immediately, get notified on completion)',
        },
        gate: {
          type: 'string',
          description:
            'Shell command to verify the round (run in the workspace after completion; ' +
            'exit code decides pass/fail), e.g. "pnpm test"',
        },
      },
      required: ['operation'],
    } as unknown as ToolDefinition['parameters'],
    async execute(_toolCallId, params, signal) {
      const {
        operation,
        name = '',
        agent_type: agentTypeName,
        model: modelName,
        task = '',
        message = '',
        wait = false,
        gate,
      } = params as {
        operation?: string;
        name?: string;
        agent_type?: string;
        model?: string;
        task?: string;
        message?: string;
        wait?: boolean;
        gate?: string;
      };
      const text = (value: string) => ({
        content: [{ type: 'text' as const, text: value }],
        details: undefined,
      });
      const sendOptions: CoworkerSendOptions = {
        signal,
        wait,
        ...(gate ? { gate } : {}),
      };
      switch (operation) {
        case 'spawn': {
          if (!name.trim()) throw new Error('spawn requires a name');
          if (!task.trim()) throw new Error('spawn requires a task');
          if (agentTypeName && !deps.agentTypes.some((type) => type.name === agentTypeName)) {
            throw new Error(
              `unknown agent_type "${agentTypeName}". Available: [${typeList}] or omit for general.`
            );
          }
          if (modelName && !deps.models.some((option) => option.name === modelName)) {
            throw new Error(
              `unknown model "${modelName}". Available: [${modelNames.join(', ')}] or omit to inherit.`
            );
          }
          const targetType = agentTypeName
            ? deps.agentTypes.find((type) => type.name === agentTypeName)
            : undefined;
          if (targetType && targetType.allowModelOverride === false && modelName) {
            throw new Error(
              `agent_type "${targetType.name}" does not allow custom model selection (it is locked to ${targetType.model ? targetType.model.modelId : 'conversation model'}).`
            );
          }
          const info = await deps.spawn(name.trim(), agentTypeName, modelName);
          // 角色提示由 supervisor 的 pendingRole 机制在首条前缀注入
          const result = await deps.send(info.name, task, sendOptions);
          return text(
            `Coworker "${info.name}" hired${info.agentType ? ` (${info.agentType})` : ''}.\n\n${truncate(result)}`
          );
        }
        case 'send': {
          if (!name.trim()) throw new Error('send requires a name');
          if (!message.trim()) throw new Error('send requires a message');
          const result = await deps.send(
            name.trim(),
            `<message-from-main-agent>\n${message}\n</message-from-main-agent>`,
            sendOptions
          );
          return text(truncate(result));
        }
        case 'list': {
          const roster = deps.list();
          if (roster.length === 0) return text('(no coworkers hired)');
          return text(
            roster
              .map(
                (info) =>
                  `- ${info.name}${info.agentType ? ` (${info.agentType})` : ''} — ${info.status}` +
                  `${info.modelId ? ` · ${info.modelId}` : ''}`
              )
              .join('\n')
          );
        }
        case 'dismiss': {
          if (!name.trim()) throw new Error('dismiss requires a name');
          await deps.dismiss(name.trim());
          return text(`Coworker "${name.trim()}" dismissed.`);
        }
        default:
          throw new Error(`unknown operation "${operation}". Use spawn/send/list/dismiss.`);
      }
    },
  };
}
