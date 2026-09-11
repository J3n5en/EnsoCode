/** 本地推理诊断：只计数，禁止带原文。thought=0 只表示没有 thought segment，不能据此断定未思考。 */

export interface TokenMeterSnapshot {
  usedInputTokens: number;
  usedOutputTokens: number;
}

export interface ThoughtChunk {
  type?: string;
  segmentType?: string;
  text?: string;
  tokens?: readonly unknown[];
}

export interface LocalInferenceDiag {
  inputTokens: number | null;
  outputTokens: number | null;
  /** 含 prefill；第一个 onResponseChunk，不一定是独立「首 token」。 */
  firstTokenMs: number | null;
  /** session.prompt 墙钟，含 prefill 与整段生成。 */
  promptMs: number;
  thoughtChars: number;
  thoughtTokens: number;
  gpu: string | boolean | null;
  gpuLayers: number | null;
  flashAttentionConfig: string | boolean | null;
  finalTextChars: number | null;
}

export function tokenMeterDelta(
  before: TokenMeterSnapshot | undefined,
  after: TokenMeterSnapshot | undefined
): { inputTokens: number | null; outputTokens: number | null } {
  if (!before || !after) return { inputTokens: null, outputTokens: null };
  return {
    inputTokens: Math.max(0, after.usedInputTokens - before.usedInputTokens),
    outputTokens: Math.max(0, after.usedOutputTokens - before.usedOutputTokens),
  };
}

export function addThoughtChunk(
  stats: { thoughtChars: number; thoughtTokens: number },
  chunk: ThoughtChunk
): void {
  if (chunk.type !== 'segment' || chunk.segmentType !== 'thought') return;
  stats.thoughtChars += typeof chunk.text === 'string' ? chunk.text.length : 0;
  stats.thoughtTokens += Array.isArray(chunk.tokens) ? chunk.tokens.length : 0;
}

/** 写入日志前收成闭集，避免 lastDiag 被塞进原文。 */
export function publicInferenceDiag(
  diag: LocalInferenceDiag | undefined
): Partial<LocalInferenceDiag> {
  if (!diag) return {};
  return {
    inputTokens: diag.inputTokens,
    outputTokens: diag.outputTokens,
    firstTokenMs: diag.firstTokenMs,
    promptMs: diag.promptMs,
    thoughtChars: diag.thoughtChars,
    thoughtTokens: diag.thoughtTokens,
    gpu: diag.gpu,
    gpuLayers: diag.gpuLayers,
    flashAttentionConfig: diag.flashAttentionConfig,
    finalTextChars: diag.finalTextChars,
  };
}
