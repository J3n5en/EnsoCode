import {
  charsToTokens,
  type OccupancySkill,
  type OccupancyTool,
  skillOccupancyText,
  toolOccupancyText,
} from '@shared/occupancy';
import {
  CONTEXT_OCCUPANCY_BUCKETS,
  type ContextOccupancy,
  type ContextOccupancyBuckets,
} from '@shared/types/agent';

export type { ContextOccupancy, ContextOccupancyBuckets, OccupancySkill, OccupancyTool };
export { CONTEXT_OCCUPANCY_BUCKETS, charsToTokens };

export interface ContextOccupancyInput {
  systemText: string;
  instructionText: string;
  skillTexts: readonly string[];
  toolDefinitionTexts: readonly string[];
  conversationTokens: number;
  compactionTokens: number;
  compactedMessageCount: number;
  projectMemoryText: string;
  projectMemoryEnabled: boolean;
  reminderText: string;
  currentModelFamily: string;
  compactionModelFamily?: string;
  contextWindow?: number;
  compactionEntryId?: string;
  usedOverride?: number;
  anchored?: boolean;
}

function joinLength(texts: readonly string[]): number {
  return texts.reduce((sum, text) => sum + text.length, 0);
}

function modelFamily(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

export interface OccupancyCompactionEntry {
  type: 'compaction';
  id: string;
  firstKeptEntryId: string;
  summary: string;
}

export interface OccupancyBranchEntry {
  type: string;
  id: string;
  parentId?: string | null;
  timestamp?: string;
  firstKeptEntryId?: string;
  summary?: string;
  tokensBefore?: number;
}

export interface CollectContextOccupancyInput {
  systemPrompt: string;
  agentsFiles: ReadonlyArray<{ path: string; content: string }>;
  skills: readonly OccupancySkill[];
  tools: readonly OccupancyTool[];
  contextMessages: readonly unknown[];
  branch: readonly OccupancyBranchEntry[];
  currentModelFamily: string;
  compactionModelFamily?: string;
  contextWindow?: number;
  pendingTaskReminders?: readonly string[];
  projectMemoryText?: string;
  projectMemoryEnabled?: boolean;
  estimateMessageTokens?: (message: unknown) => number;
}

function latestCompaction(
  branch: readonly OccupancyBranchEntry[]
): OccupancyCompactionEntry | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === 'compaction' && typeof entry.summary === 'string') {
      return {
        type: 'compaction',
        id: entry.id,
        firstKeptEntryId: entry.firstKeptEntryId ?? '',
        summary: entry.summary,
      };
    }
  }
  return undefined;
}

function compactedCount(
  branch: readonly OccupancyBranchEntry[],
  compaction: OccupancyCompactionEntry | undefined
): number {
  if (!compaction) return 0;
  const kept = compaction.firstKeptEntryId
    ? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId)
    : -1;
  const compactionIndex = branch.findIndex((entry) => entry.id === compaction.id);
  const cut = kept >= 0 && (compactionIndex < 0 || kept < compactionIndex) ? kept : compactionIndex;
  return cut >= 0 ? cut : 0;
}

function defaultEstimate(message: unknown): number {
  const record = (message ?? {}) as Record<string, unknown>;
  const role = typeof record.role === 'string' ? record.role : '';
  if (role === 'compactionSummary' && typeof record.summary === 'string') {
    return charsToTokens(record.summary.length);
  }
  if (typeof record.content === 'string') return charsToTokens(record.content.length);
  if (!Array.isArray(record.content)) return 0;
  let chars = 0;
  for (const part of record.content) {
    if (!part || typeof part !== 'object') continue;
    const block = part as Record<string, unknown>;
    if (typeof block.text === 'string') chars += block.text.length;
    if (typeof block.thinking === 'string') chars += block.thinking.length;
  }
  return charsToTokens(chars);
}

export function collectContextOccupancy(input: CollectContextOccupancyInput): ContextOccupancy {
  const compaction = latestCompaction(input.branch);
  const estimate = input.estimateMessageTokens ?? defaultEstimate;
  let conversationTokens = 0;
  for (const message of input.contextMessages) {
    if ((message as { role?: string }).role === 'compactionSummary') continue;
    conversationTokens += Math.max(0, estimate(message));
  }
  const instructionText = input.agentsFiles.map((file) => file.content).join('\n');
  return summarizeContextOccupancy({
    systemText: input.systemPrompt,
    instructionText,
    skillTexts: input.skills.map(skillOccupancyText),
    toolDefinitionTexts: input.tools.map(toolOccupancyText),
    conversationTokens,
    compactionTokens: compaction ? charsToTokens(compaction.summary.length) : 0,
    compactedMessageCount: compactedCount(input.branch, compaction),
    projectMemoryText: input.projectMemoryText ?? '',
    projectMemoryEnabled: input.projectMemoryEnabled ?? true,
    reminderText: (input.pendingTaskReminders ?? []).join('\n'),
    currentModelFamily: input.currentModelFamily,
    compactionModelFamily: input.compactionModelFamily,
    contextWindow: input.contextWindow,
    compactionEntryId: compaction?.id,
  });
}

export function summarizeContextOccupancy(input: ContextOccupancyInput): ContextOccupancy {
  const buckets: ContextOccupancyBuckets = {
    system: charsToTokens(input.systemText.length),
    instructions: charsToTokens(input.instructionText.length),
    skills: charsToTokens(joinLength(input.skillTexts)),
    tools: charsToTokens(joinLength(input.toolDefinitionTexts)),
    conversation: Math.max(0, Math.round(input.conversationTokens)),
    compaction: Math.max(0, Math.round(input.compactionTokens)),
    projectMemory:
      input.projectMemoryEnabled && input.projectMemoryText.trim().length > 0
        ? charsToTokens(input.projectMemoryText.length)
        : 0,
    reminders: charsToTokens(input.reminderText.length),
  };
  const bucketSum = CONTEXT_OCCUPANCY_BUCKETS.reduce((sum, id) => sum + buckets[id], 0);
  const used =
    input.usedOverride !== undefined ? Math.max(0, Math.round(input.usedOverride)) : bucketSum;
  if (input.usedOverride !== undefined) {
    const others = bucketSum - buckets.conversation;
    buckets.conversation = Math.max(0, used - others);
  }
  const current = modelFamily(input.currentModelFamily);
  const compacted = modelFamily(input.compactionModelFamily);
  const compactionModelMismatch = Boolean(compacted) && Boolean(current) && compacted !== current;
  const window = input.contextWindow && input.contextWindow > 0 ? input.contextWindow : undefined;
  return {
    buckets,
    used,
    estimated: input.anchored !== true,
    compactedMessageCount: Math.max(0, Math.round(input.compactedMessageCount)),
    compactionModelMismatch,
    ...(window !== undefined ? { contextWindow: window } : {}),
    ...(window !== undefined ? { percent: Math.min(100, Math.round((used / window) * 100)) } : {}),
    ...(input.compactionEntryId ? { compactionEntryId: input.compactionEntryId } : {}),
  };
}
