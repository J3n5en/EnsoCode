export interface UsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  contextTokens?: number;
  totalTokens?: number;
  orchestration?: { input?: number; output?: number; cacheRead?: number };
}

export interface ContextUsageSnapshot {
  promptTokens: number;
  nonMessageTokens: number;
  compactionEpoch: number;
  historyRewriteTokensRemoved?: number;
}

export interface AnchorMessage {
  role: string;
  stopReason?: string;
  usage?: UsageLike;
  timestamp?: number;
  contextSnapshot?: ContextUsageSnapshot;
}

export interface PendingContextSnapshotInput {
  promptTokens: number;
  nonMessageTokens: number;
  cutoffCount: number;
}

export function calculateContextTokens(usage: UsageLike): number {
  if (usage.contextTokens !== undefined) return Math.max(0, usage.contextTokens);
  const orchestration = usage.orchestration;
  const orchestrationTotal = orchestration
    ? (orchestration.input ?? 0) + (orchestration.output ?? 0) + (orchestration.cacheRead ?? 0)
    : 0;
  const raw = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return Math.max(0, raw - orchestrationTotal);
}

export function calculatePromptTokens(usage: UsageLike): number {
  if (usage.contextTokens !== undefined) return Math.max(0, usage.contextTokens);
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  if (promptTokens > 0) return promptTokens;
  return calculateContextTokens(usage);
}

export function hasContextTokenUsage(usage: UsageLike): boolean {
  return (
    (usage.contextTokens ?? 0) > 0 ||
    usage.input + usage.cacheRead + usage.cacheWrite > 0 ||
    calculateContextTokens(usage) > usage.output
  );
}

export function isTranscriptUsageAnchor(message: AnchorMessage): boolean {
  if (message.role !== 'assistant') return false;
  if (message.stopReason === 'aborted' || message.stopReason === 'error') return false;
  return message.usage !== undefined && hasContextTokenUsage(message.usage);
}

export function findTranscriptUsageAnchor(
  messages: readonly AnchorMessage[],
  fromIndex = 0
): { index: number; message: AnchorMessage; tokens: number } | undefined {
  for (let index = messages.length - 1; index >= fromIndex; index--) {
    const message = messages[index];
    if (!isTranscriptUsageAnchor(message) || !message.usage) continue;
    return { index, message, tokens: calculateContextTokens(message.usage) };
  }
  return undefined;
}

function correctedPromptTokens(assistant: AnchorMessage): number {
  const usage = assistant.usage;
  const providerPromptTokens =
    assistant.contextSnapshot?.promptTokens ?? (usage ? calculatePromptTokens(usage) : 0);
  return Math.max(
    0,
    providerPromptTokens - (assistant.contextSnapshot?.historyRewriteTokensRemoved ?? 0)
  );
}

function sumEstimates(
  messages: readonly unknown[],
  from: number,
  estimate: (message: unknown) => number
): number {
  let total = 0;
  for (let i = from; i < messages.length; i++) {
    total += Math.max(0, estimate(messages[i]));
  }
  return total;
}

function resolveActiveIndex(
  activeMessages: readonly AnchorMessage[],
  assistant: AnchorMessage
): number {
  const byRef = activeMessages.indexOf(assistant);
  if (byRef !== -1) return byRef;
  if (assistant.timestamp === undefined) return -1;
  return activeMessages.findIndex(
    (message) => message.role === 'assistant' && message.timestamp === assistant.timestamp
  );
}

export class ContextUsageTracker {
  #compactionEpoch = 0;
  #pending: (PendingContextSnapshotInput & { epoch: number }) | undefined;
  #stamped = new Map<number, ContextUsageSnapshot>();

  get compactionEpoch(): number {
    return this.#compactionEpoch;
  }

  get pendingNonMessageTokens(): number | undefined {
    return this.#pending?.nonMessageTokens;
  }

  setPendingSnapshot(snapshot: PendingContextSnapshotInput | undefined): void {
    this.#pending = snapshot ? { ...snapshot, epoch: this.#compactionEpoch } : undefined;
  }

  rebaseAfterCompaction(next?: PendingContextSnapshotInput): void {
    this.#compactionEpoch += 1;
    if (!this.#pending) return;
    if (next) this.setPendingSnapshot(next);
  }

  recordAnchoredHistoryRewrite(
    tokensRemoved: number,
    messages: readonly AnchorMessage[],
    compactionIndex: number,
    currentNonMessageTokens: number
  ): void {
    if (!Number.isFinite(tokensRemoved) || tokensRemoved <= 0) return;
    for (let index = messages.length - 1; index > compactionIndex; index--) {
      const message = messages[index];
      if (!isTranscriptUsageAnchor(message) || !message.usage) continue;
      if (!message.contextSnapshot) {
        message.contextSnapshot = {
          promptTokens: calculatePromptTokens(message.usage),
          nonMessageTokens: currentNonMessageTokens,
          compactionEpoch: this.#compactionEpoch,
        };
      }
      const snapshot = message.contextSnapshot;
      snapshot.historyRewriteTokensRemoved =
        (snapshot.historyRewriteTokensRemoved ?? 0) + Math.floor(tokensRemoved);
      return;
    }
  }

  stampSettledAnchor(message: AnchorMessage, currentNonMessageTokens: number): void {
    if (!isTranscriptUsageAnchor(message) || !message.usage) return;
    message.contextSnapshot = {
      promptTokens: calculatePromptTokens(message.usage),
      nonMessageTokens: this.#pending?.nonMessageTokens ?? currentNonMessageTokens,
      compactionEpoch: this.#compactionEpoch,
    };
    if (message.timestamp !== undefined)
      this.#stamped.set(message.timestamp, message.contextSnapshot);
  }

  snapshotFor(message: AnchorMessage): ContextUsageSnapshot | undefined {
    return (
      message.contextSnapshot ??
      (message.timestamp !== undefined ? this.#stamped.get(message.timestamp) : undefined)
    );
  }

  getBreakdown(input: {
    contextWindow?: number;
    activeMessages: readonly AnchorMessage[];
    branchMessages?: readonly AnchorMessage[];
    compactionIndex?: number;
    currentNonMessageTokens: number;
    categoryNonMessageTokens: number;
    pendingMessages?: readonly unknown[];
    estimateMessageTokens: (message: unknown) => number;
  }): {
    contextWindow: number;
    anchored: boolean;
    usedTokens: number;
    messagesTokens: number;
  } {
    const rawWindow = input.contextWindow;
    const contextWindow =
      Number.isFinite(rawWindow) && (rawWindow ?? 0) > 0 ? (rawWindow as number) : 0;
    const estimate = input.estimateMessageTokens;
    const pendingTokens = input.pendingMessages
      ? sumEstimates(input.pendingMessages, 0, estimate)
      : 0;
    const currentNonMessageTokens = input.currentNonMessageTokens;
    const branchMessages = input.branchMessages ?? input.activeMessages;
    const compactionIndex = input.compactionIndex ?? -1;
    const pending = this.#pending;

    let usedTokens = 0;
    let anchored = false;

    let anchorEntry: AnchorMessage | undefined;
    for (let index = branchMessages.length - 1; index > compactionIndex; index--) {
      const entry = branchMessages[index];
      if (!isTranscriptUsageAnchor(entry)) continue;
      anchorEntry = entry;
      break;
    }

    let anchorIndex = -1;
    if (anchorEntry) {
      anchorIndex = resolveActiveIndex(input.activeMessages, anchorEntry);
    }

    const anchorEpoch = anchorEntry?.contextSnapshot?.compactionEpoch ?? 0;
    const useAnchor =
      anchorEntry !== undefined &&
      anchorIndex !== -1 &&
      (!pending || (anchorIndex >= pending.cutoffCount && anchorEpoch >= pending.epoch));

    if (useAnchor && anchorEntry) {
      const anchorNonMessage =
        anchorEntry.contextSnapshot?.nonMessageTokens ?? currentNonMessageTokens;
      anchored = true;
      usedTokens =
        correctedPromptTokens(anchorEntry) +
        Math.max(0, currentNonMessageTokens - anchorNonMessage) +
        sumEstimates(input.activeMessages, anchorIndex + 1, estimate) +
        pendingTokens;
    } else if (pending) {
      anchored = true;
      usedTokens =
        pending.promptTokens +
        Math.max(0, currentNonMessageTokens - pending.nonMessageTokens) +
        sumEstimates(input.activeMessages, pending.cutoffCount, estimate) +
        pendingTokens;
    } else if (branchMessages.length === 0) {
      const liveAnchor = findTranscriptUsageAnchor(input.activeMessages);
      if (liveAnchor) {
        const anchorNonMessage =
          liveAnchor.message.contextSnapshot?.nonMessageTokens ?? currentNonMessageTokens;
        anchored = true;
        usedTokens =
          correctedPromptTokens(liveAnchor.message) +
          Math.max(0, currentNonMessageTokens - anchorNonMessage) +
          sumEstimates(input.activeMessages, liveAnchor.index + 1, estimate) +
          pendingTokens;
      }
    }

    if (!anchored) {
      usedTokens =
        currentNonMessageTokens + sumEstimates(input.activeMessages, 0, estimate) + pendingTokens;
    }

    return {
      contextWindow,
      anchored,
      usedTokens,
      messagesTokens: Math.max(0, usedTokens - input.categoryNonMessageTokens),
    };
  }
}
