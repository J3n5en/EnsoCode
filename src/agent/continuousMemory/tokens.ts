import { estimateTokens as estimateMessageTokens } from '@earendil-works/pi-coding-agent';

export const estimateStringTokens = (text: string): number => Math.ceil(text.length / 4);

export function observationLineTokenCount(observation: {
  id: string;
  timestamp: string;
  relevance: string;
  content: string;
}): number {
  return estimateStringTokens(
    `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`
  );
}

export function estimateEntryTokens(entry: {
  type: string;
  message?: unknown;
  content?: unknown;
  summary?: unknown;
}): number {
  if (entry.type === 'message' && entry.message) {
    return estimateMessageTokens(entry.message as Parameters<typeof estimateMessageTokens>[0]);
  }
  if (entry.type === 'custom_message')
    return estimateStringTokens(JSON.stringify(entry.content ?? ''));
  if (entry.type === 'branch_summary' && typeof entry.summary === 'string') {
    return estimateStringTokens(entry.summary);
  }
  return 0;
}
