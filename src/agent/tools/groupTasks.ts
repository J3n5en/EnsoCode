import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { normalizeTaskCheck } from '@shared/bots/taskCheck';
import { CHECK_SCHEMA, type DelegationOp } from './delegation';
import type { MemoryInvoker } from './memory';

const ACTIONS = ['list', 'add', 'claim', 'update', 'complete', 'cancel'] as const;
const ALIASES: Record<string, (typeof ACTIONS)[number]> = {
  create: 'add',
  new: 'add',
  take: 'claim',
  edit: 'update',
  done: 'complete',
  finish: 'complete',
};

/** schema 校验前归一化：action 别名 / 大小写，id 数字与别名键，可选键的 null */
export function normalizeGroupTaskParams(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const params = { ...raw } as Record<string, unknown>;
  for (const alias of ['taskId', 'task_id']) {
    if (params.id === undefined || params.id === null) params.id = params[alias];
    delete params[alias];
  }
  for (const key of ['id', 'title', 'detail', 'result']) {
    if (params[key] === null || params[key] === undefined) delete params[key];
  }
  if ('check' in params) {
    params.check = normalizeTaskCheck(params.check);
    if (params.check === undefined) delete params.check;
  }
  if (typeof params.id === 'number') params.id = String(params.id);
  if (typeof params.action === 'string') {
    const action = params.action.trim().toLowerCase();
    params.action = ALIASES[action] ?? action;
  }
  return params;
}

export function createGroupTasksTool(invoker: MemoryInvoker<DelegationOp>): ToolDefinition {
  return {
    name: 'group_tasks',
    label: 'group_tasks',
    description:
      "Shared task board of this group chat. list: open tasks (#N, status, assignee, check). add: create a task (title, optional detail, optional check) - only for real multi-step work, not every message. claim: take a todo task (id) before working on it; fails if someone already claimed it. update: edit title/detail (check only by its creator). complete: finish a task you claimed, with result (what was done); if the task has a check, complete is rejected unless one of your final tool outputs since claiming contains check.text. cancel: drop a task you created or own. Ids look like '#3'.",
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...ACTIONS] },
        id: { type: 'string', minLength: 1, description: "Task id such as '#3'" },
        title: { type: 'string', minLength: 1, maxLength: 200 },
        detail: { type: 'string' },
        result: { type: 'string', description: 'Completion summary (required for complete)' },
        check: CHECK_SCHEMA,
      },
      required: ['action'],
      additionalProperties: false,
    } as unknown as ToolDefinition['parameters'],
    prepareArguments: normalizeGroupTaskParams as ToolDefinition['prepareArguments'],
    async execute(_id, params, signal) {
      try {
        const result = await invoker.invoke(
          'group_tasks',
          normalizeGroupTaskParams(params),
          signal
        );
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: undefined };
      } catch (error) {
        return {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          details: undefined,
          isError: true,
        };
      }
    },
  };
}
