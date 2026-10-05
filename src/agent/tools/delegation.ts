import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { normalizeTaskCheck } from '@shared/bots/taskCheck';
import type { MemoryInvoker } from './memory';

export type DelegationOp =
  | 'delegate'
  | 'check_delegation'
  | 'group_tasks'
  | 'group_history'
  | 'routine_propose'
  | 'send_image';

export function normalizeDelegationParams(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const params = { ...raw } as Record<string, unknown>;
  for (const key of ['id', 'context', 'cancel', 'taskId', 'deadlineMinutes', 'keep'])
    if (params[key] === null) delete params[key];
  for (const key of ['cancel', 'keep']) {
    if (params[key] === 'true') params[key] = true;
    if (params[key] === 'false') params[key] = false;
  }
  if (typeof params.taskId === 'number') params.taskId = String(params.taskId);
  if (typeof params.deadlineMinutes === 'string' && params.deadlineMinutes.trim()) {
    const minutes = Number(params.deadlineMinutes);
    if (Number.isFinite(minutes)) params.deadlineMinutes = minutes;
  }
  if ('check' in params) {
    params.check = normalizeTaskCheck(params.check);
    if (params.check === undefined) delete params.check;
  }
  return params;
}

export const CHECK_SCHEMA = {
  type: 'object',
  description:
    'Verifiable completion condition: done only if a tool result (e.g. a command output) contains text. A plain string is accepted as the text.',
  properties: {
    kind: { type: 'string', enum: ['output-contains'] },
    text: { type: 'string', minLength: 1, maxLength: 200 },
  },
  required: ['kind', 'text'],
  additionalProperties: false,
};

export function createDelegationTools(
  invoker: MemoryInvoker<DelegationOp>,
  options: { groupTasks?: boolean } = {}
): ToolDefinition[] {
  const define = (
    name: DelegationOp,
    description: string,
    properties: Record<string, unknown>,
    required: string[]
  ): ToolDefinition => ({
    name,
    label: name,
    description,
    parameters: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    } as unknown as ToolDefinition['parameters'],
    prepareArguments: normalizeDelegationParams as ToolDefinition['prepareArguments'],
    async execute(_id, params, signal) {
      try {
        const result = await invoker.invoke(name, normalizeDelegationParams(params), signal);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: undefined };
      } catch (error) {
        return {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          details: undefined,
          isError: true,
        };
      }
    },
  });
  return [
    define(
      'delegate',
      "Delegate a task to another member by name or id. Returns immediately; results arrive asynchronously. Context is truncated to 8000 characters. The delegation fails with a timeout after deadlineMinutes (capped by the member's own limit, 240 minutes by default). If the user stops or interrupts your current turn, delegations started in it are canceled unless keep is true." +
        " With check, the delegation passes only if one of the member's final tool outputs contains check.text; otherwise it ends as failed with 'acceptance check failed'." +
        (options.groupTasks
          ? ' Pass taskId (e.g. "#3") to hand a group board task to the member: the task becomes doing with them as assignee, and is marked done (or returned to todo on failure/cancel) when the delegation ends.'
          : ''),
      {
        to: { type: 'string', minLength: 1 },
        task: { type: 'string', minLength: 1 },
        context: { type: 'string' },
        ...(options.groupTasks ? { taskId: { type: 'string', minLength: 1 } } : {}),
        deadlineMinutes: { type: 'number', minimum: 1 },
        keep: { type: 'boolean' },
        check: CHECK_SCHEMA,
      },
      ['to', 'task']
    ),
    define(
      'check_delegation',
      'List your delegations, inspect one by id, or cancel it (id required for cancel).',
      { id: { type: 'string', minLength: 1 }, cancel: { type: 'boolean' } },
      []
    ),
  ];
}
