import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { DelegationOp } from './delegation';
import type { MemoryInvoker } from './memory';

const MAX_LIMIT = 100;
const ALIASES: Record<string, string> = {
  before: 'beforeSeq',
  before_seq: 'beforeSeq',
  after: 'afterSeq',
  after_seq: 'afterSeq',
  count: 'limit',
  keyword: 'query',
  q: 'query',
  search: 'query',
  speaker: 'from',
  sender: 'from',
  member: 'from',
};

function integer(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : value;
  if (typeof value !== 'string') return value;
  const text = value.trim().replace(/^#/, '');
  return /^-?\d+$/.test(text) ? Number(text) : value;
}

/** schema 校验前归一化：别名键、数字串 / 小数 → 整数、limit 夹到 [1,100]、空值删除 */
export function normalizeGroupHistoryParams(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const params = { ...raw } as Record<string, unknown>;
  for (const [alias, key] of Object.entries(ALIASES)) {
    if (!(alias in params)) continue;
    if (params[key] === undefined || params[key] === null) params[key] = params[alias];
    delete params[alias];
  }
  for (const key of ['beforeSeq', 'afterSeq', 'limit']) params[key] = integer(params[key]);
  if (typeof params.limit === 'number')
    params.limit = Math.min(MAX_LIMIT, Math.max(1, params.limit));
  if (typeof params.query === 'string') params.query = params.query.trim();
  if (typeof params.from === 'string') params.from = params.from.trim().replace(/^@/, '');
  for (const key of ['beforeSeq', 'afterSeq', 'limit', 'query', 'from'])
    if (params[key] === null || params[key] === undefined || params[key] === '') delete params[key];
  return params;
}

export function createGroupHistoryTool(invoker: MemoryInvoker<DelegationOp>): ToolDefinition {
  return {
    name: 'group_history',
    label: 'group_history',
    description:
      'Read the original messages of this group chat timeline (read-only). Use it when your context was compacted or you need the exact earlier wording. Entries have seq numbers matching the seq of <group-message>. Without seq bounds returns the latest entries; beforeSeq pages older, afterSeq pages newer. Filter with query (case-insensitive substring) and from (member name, or "用户" for the human). When hasMore is true, call again with beforeSeq = the first returned seq (or afterSeq = the last one when paging forward). Long texts are truncated.',
    parameters: {
      type: 'object',
      properties: {
        beforeSeq: {
          type: 'integer',
          minimum: 1,
          description: 'Only entries with seq < beforeSeq',
        },
        afterSeq: { type: 'integer', minimum: 0, description: 'Only entries with seq > afterSeq' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: 'Default 30' },
        query: { type: 'string', minLength: 1, maxLength: 200 },
        from: { type: 'string', minLength: 1, maxLength: 64, description: 'Speaker name or 用户' },
      },
      required: [],
      additionalProperties: false,
    } as unknown as ToolDefinition['parameters'],
    prepareArguments: normalizeGroupHistoryParams as ToolDefinition['prepareArguments'],
    async execute(_id, params, signal) {
      try {
        const result = await invoker.invoke(
          'group_history',
          normalizeGroupHistoryParams(params),
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
