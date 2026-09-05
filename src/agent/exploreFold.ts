import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

export interface LlmMessage {
  role: string;
  content?: unknown;
  toolCalls?: Array<{ name?: string }>;
}

export interface ExploreFoldSpan {
  from: number;
  to: number;
  report: string;
}

export interface ExploreFoldState {
  mark(goal: string): void;
  fold(report: string): ExploreFoldSpan;
  apply(messages: LlmMessage[]): LlmMessage[];
  pending: boolean;
}

export function applyExploreFold(
  messages: LlmMessage[],
  folds: readonly ExploreFoldSpan[]
): LlmMessage[] {
  if (folds.length === 0) return messages;
  const sorted = [...folds].sort((a, b) => a.from - b.from);
  const out: LlmMessage[] = [];
  let cursor = 0;
  for (const fold of sorted) {
    if (fold.from < cursor || fold.to >= messages.length || fold.from > fold.to) continue;
    out.push(...messages.slice(cursor, fold.from));
    out.push({
      role: 'user',
      content: `Explore report:\n${fold.report}`,
    });
    cursor = fold.to + 1;
  }
  out.push(...messages.slice(cursor));
  return out;
}

export function createExploreFoldState(): ExploreFoldState {
  let pendingGoal: string | undefined;
  const reports: string[] = [];

  return {
    get pending() {
      return pendingGoal !== undefined;
    },
    mark(goal: string) {
      if (pendingGoal !== undefined)
        throw new Error('explore_mark already active — call explore_fold first');
      const trimmed = goal.trim();
      if (!trimmed) throw new Error('goal is required');
      pendingGoal = trimmed;
    },
    fold(report: string) {
      if (pendingGoal === undefined) throw new Error('no active explore_mark');
      const trimmed = report.trim();
      if (!trimmed) throw new Error('report is required');
      reports.push(trimmed);
      pendingGoal = undefined;
      return { from: 0, to: 0, report: trimmed };
    },
    apply(messages) {
      const pairs = pairMarkFold(messages);
      const folds = reports
        .map((report, index) => {
          const pair = pairs[index];
          return pair ? { ...pair, report } : undefined;
        })
        .filter((fold): fold is ExploreFoldSpan => fold !== undefined);
      return applyExploreFold(messages, folds);
    },
  };
}

function messageHasTool(message: LlmMessage | undefined, name: string): boolean {
  return Boolean(message?.toolCalls?.some((call) => call.name === name));
}

function pairMarkFold(messages: LlmMessage[]): Array<{ from: number; to: number }> {
  const pairs: Array<{ from: number; to: number }> = [];
  let markAt: number | undefined;
  for (let i = 0; i < messages.length; i++) {
    if (messageHasTool(messages[i], 'explore_mark') && markAt === undefined) markAt = i;
    if (messageHasTool(messages[i], 'explore_fold') && markAt !== undefined) {
      pairs.push({ from: markAt, to: i });
      markAt = undefined;
    }
  }
  return pairs;
}

export function createExploreFoldTools(state: ExploreFoldState): ToolDefinition[] {
  return [
    {
      name: 'explore_mark',
      label: 'Explore mark',
      description:
        'Start an explore-fold: mark before a burst of read/grep/find. MUST call explore_fold with a concise report before finishing.',
      promptSnippet:
        'explore_mark / explore_fold: mark before exploratory reads, then fold so only the report stays in later LLM context.',
      parameters: {
        type: 'object',
        properties: { goal: { type: 'string', description: 'What you are investigating' } },
        required: ['goal'],
      } as unknown as ToolDefinition['parameters'],
      async execute(_id, params) {
        const goal = String((params as { goal?: string }).goal ?? '');
        state.mark(goal);
        return {
          content: [{ type: 'text' as const, text: `Explore marked: ${goal.trim()}` }],
          details: undefined,
        };
      },
    },
    {
      name: 'explore_fold',
      label: 'Explore fold',
      description:
        'End the active explore-fold. Intermediate tool rounds are removed from later LLM context and replaced by this report. Timeline stays intact.',
      parameters: {
        type: 'object',
        properties: { report: { type: 'string', description: 'Concise findings to keep' } },
        required: ['report'],
      } as unknown as ToolDefinition['parameters'],
      async execute(_id, params) {
        const report = String((params as { report?: string }).report ?? '');
        state.fold(report);
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Explore folded. Subsequent turns see only this report.',
            },
          ],
          details: { report: report.trim() },
        };
      },
    },
  ];
}
