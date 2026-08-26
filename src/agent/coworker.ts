import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentTypeSpawnConfig, CoworkerInfo } from '@shared/types/agent';

/** 回传主 agent 的结果上限,全文永远在 coworker tab 里 */
const RESULT_LIMIT = 4000;

export interface CoworkerToolDeps {
  agentTypes: AgentTypeSpawnConfig[];
  /** 雇佣:创建持久子会话并登记(不发首条消息) */
  spawn(name: string, agentTypeName?: string): Promise<CoworkerInfo>;
  /** 发消息并阻塞至该轮结束,返回最终 assistant 文本;父 abort 时提前返回、不杀 coworker */
  send(name: string, message: string, signal?: AbortSignal): Promise<string>;
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
  return {
    name: 'coworker',
    label: 'Coworker',
    description:
      'Hire a persistent coworker agent that keeps its own context across multiple send calls. ' +
      'Unlike `subagent` (one-shot, disposed after a single report), a coworker stays alive: ' +
      'spawn it once with a role and initial task, then send follow-ups that build on everything it has seen. ' +
      'The user watches each coworker in its own tab and may reply there directly — ' +
      'replies you get may reflect user interventions. ' +
      'Operations: spawn {name, agent_type?, task} / send {name, message} / list / dismiss {name}. ' +
      'Results are truncated; the full transcript lives in the coworker tab.' +
      (typeList ? ` Available agent types: ${typeList}.` : ''),
    promptSnippet:
      'coworker: hire a persistent named agent (own tab, own accumulating context, multi-round). ' +
      'Use subagent for self-contained one-shot subtasks (cheaper, no lingering context); ' +
      'use coworker when work needs multiple rounds against the same accumulated context ' +
      '(a reviewer consulted repeatedly, an implementer assigned related tasks in sequence) ' +
      'or when the user should watch and join the side conversation. ' +
      'Coworkers cost resources while alive — dismiss them when done; prefer few with clear roles',
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
        task: { type: 'string', description: 'Initial task for spawn, self-contained' },
        message: { type: 'string', description: 'Message for send' },
      },
      required: ['operation'],
    } as unknown as ToolDefinition['parameters'],
    async execute(_toolCallId, params, signal) {
      const {
        operation,
        name = '',
        agent_type: agentTypeName,
        task = '',
        message = '',
      } = params as {
        operation?: string;
        name?: string;
        agent_type?: string;
        task?: string;
        message?: string;
      };
      const text = (value: string) => ({
        content: [{ type: 'text' as const, text: value }],
        details: undefined,
      });
      switch (operation) {
        case 'spawn': {
          if (!name.trim()) throw new Error('spawn requires a name');
          if (!task.trim()) throw new Error('spawn requires a task');
          if (agentTypeName && !deps.agentTypes.some((type) => type.name === agentTypeName)) {
            throw new Error(
              `unknown agent_type "${agentTypeName}". Available: [${typeList}] or omit for general.`
            );
          }
          const info = await deps.spawn(name.trim(), agentTypeName);
          // role 只在首次雇佣的首条注入;resume 后的 send 不再带(jsonl 里已有)
          const agentType = deps.agentTypes.find((type) => type.name === info.agentType);
          const firstPrompt = agentType?.systemPrompt
            ? `<role>\n${agentType.systemPrompt}\n</role>\n\n${task}`
            : task;
          const result = await deps.send(info.name, firstPrompt, signal);
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
            signal
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
