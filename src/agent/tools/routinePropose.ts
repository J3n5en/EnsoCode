import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { DelegationOp } from './delegation';
import type { MemoryInvoker } from './memory';

const KEYS = ['title', 'prompt', 'schedule', 'doneBy'] as const;
const ALIASES: Record<string, (typeof KEYS)[number]> = {
  name: 'title',
  task: 'prompt',
  instructions: 'prompt',
  instruction: 'prompt',
  description: 'prompt',
  cron: 'schedule',
  when: 'schedule',
  time: 'schedule',
  done_by: 'doneBy',
  doneby: 'doneBy',
  executor: 'doneBy',
  assignee: 'doneBy',
  member: 'doneBy',
};

/** schema 校验前归一化：别名键、数字转串、去空白、doneBy 去 @、null / 空串删除 */
export function normalizeRoutineProposeParams(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const params = { ...raw } as Record<string, unknown>;
  for (const [alias, key] of Object.entries(ALIASES)) {
    if (!(alias in params)) continue;
    if (params[key] === undefined || params[key] === null || params[key] === '')
      params[key] = params[alias];
    delete params[alias];
  }
  for (const key of KEYS) {
    if (typeof params[key] === 'number') params[key] = String(params[key]);
    if (typeof params[key] === 'string') params[key] = (params[key] as string).trim();
  }
  if (typeof params.doneBy === 'string') params.doneBy = params.doneBy.replace(/^@/, '').trim();
  for (const key of KEYS)
    if (params[key] === null || params[key] === undefined || params[key] === '') delete params[key];
  return params;
}

export function createRoutineProposeTool(invoker: MemoryInvoker<DelegationOp>): ToolDefinition {
  return {
    name: 'routine_propose',
    label: 'routine_propose',
    description:
      'Propose a recurring routine that you will run on a schedule in this chat (e.g. a daily report, a weekly check). It is saved as a draft and only runs after the user approves it in the app; tell the user it awaits their approval. Proposing again with the same title updates that routine and needs approval again. Only use it when the user asks for something recurring or agrees to your suggestion.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200, description: 'Short name' },
        prompt: {
          type: 'string',
          minLength: 1,
          maxLength: 4000,
          description: 'What to do each time it runs, written as a self-contained instruction',
        },
        schedule: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          description:
            '5-field cron in local time (minute hour day month weekday), or a simple phrase like "daily 09:00", "weekdays 18:30", "every Monday 10:00", "每天 9:00", "工作日 18:30", "每周一 10:00", "hourly"',
        },
        doneBy: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
          description:
            'Optional: name of another member of this chat who should run it (needs delegation permission); omit to run it yourself',
        },
      },
      required: ['title', 'prompt', 'schedule'],
      additionalProperties: false,
    } as unknown as ToolDefinition['parameters'],
    prepareArguments: normalizeRoutineProposeParams as ToolDefinition['prepareArguments'],
    async execute(_id, params, signal) {
      try {
        const result = await invoker.invoke(
          'routine_propose',
          normalizeRoutineProposeParams(params),
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
