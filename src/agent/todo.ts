import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { TodoItem } from '@shared/types/agent';

const STATUSES = ['pending', 'in_progress', 'completed'] as const;

/** 整表替换语义（Claude Code TodoWrite）：渲染层只需读最后一条 todo toolResult */
const PARAMETERS = {
  type: 'object',
  properties: {
    todos: {
      type: 'array',
      description: 'The full updated todo list (replaces the previous list entirely)',
      items: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Task description' },
          status: { type: 'string', enum: [...STATUSES] },
        },
        required: ['content', 'status'],
      },
    },
  },
  required: ['todos'],
} as unknown as ToolDefinition['parameters'];

const isTodo = (value: unknown): value is TodoItem =>
  Boolean(value) &&
  typeof value === 'object' &&
  typeof (value as TodoItem).content === 'string' &&
  STATUSES.includes((value as TodoItem).status);

/**
 * 会话内任务清单工具。状态随 toolResult.details 写进会话 jsonl——
 * resume/branch 时读最后一条 todo toolResult 即为当前状态，无需外部存储。
 */
export function createTodoTool(): ToolDefinition {
  return {
    name: 'todo',
    label: 'Todo',
    description:
      'Update the task list for the current session. Pass the FULL list every time (it replaces the previous one). ' +
      'Use for multi-step tasks: mark the current step in_progress (only one at a time), completed steps completed. ' +
      'Skip it for trivial single-step requests.',
    parameters: PARAMETERS,
    async execute(_toolCallId, params) {
      const raw = (params as { todos?: unknown }).todos;
      const todos = Array.isArray(raw) ? raw.filter(isTodo) : [];
      const done = todos.filter((todo) => todo.status === 'completed').length;
      const lines = todos.map(
        (todo) =>
          `[${todo.status === 'completed' ? 'x' : todo.status === 'in_progress' ? '~' : ' '}] ${todo.content}`
      );
      return {
        content: [
          {
            type: 'text',
            text:
              todos.length > 0
                ? `Todos (${done}/${todos.length} done):\n${lines.join('\n')}`
                : 'Todo list cleared',
          },
        ],
        details: { todos },
      };
    },
  };
}
