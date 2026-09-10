import path from 'node:path';
import type { LlamaModel } from 'node-llama-cpp';
import { acquireModel, type LlamaModelLike } from '../../llama/runtime';
import type { EmbedKind } from '../types';
import { withPrefix } from './prefix';
import type { EmbeddingModelSpec, EmbeddingProvider } from './types';
import { finalize } from './vector';

export interface GgufProviderContext {
  modelDir: string;
  /** 测试注入；生产走 runtime 的模型槽 */
  acquire?: (modelPath: string) => Promise<LlamaModelLike>;
}

/**
 * llama.cpp 驱动的 embedding。相比 onnx 路径省掉了外部 tokenizer 和手写池化：
 * GGUF 内嵌 tokenizer，池化由模型元数据（pooling_type）决定，llama.cpp 直接吐句向量。
 *
 * 向量口径：必须走共享的 finalize（MRL 截断 + L2 归一化）。
 * 实测 node-llama-cpp 返回的是**未归一化**的原始句向量（bge-small 实测模长约 9.0），
 * 与「llama.cpp 默认 --embd-normalize 2」的直觉相反；不归一化会让余弦距离表退化成点积，
 * 长文本天然得分更高。这条不要凭直觉改。
 */
export async function createGgufEmbeddingProvider(
  spec: EmbeddingModelSpec,
  ctx: GgufProviderContext
): Promise<EmbeddingProvider> {
  const cfg = spec.gguf;
  if (!cfg) throw new Error(`embedding: ${spec.id} has no gguf settings`);

  const modelPath = path.join(ctx.modelDir, cfg.file);
  const acquire = ctx.acquire ?? ((p: string) => acquireModel('embedding', p));
  const model = (await acquire(modelPath)) as unknown as Pick<
    LlamaModel,
    'createEmbeddingContext' | 'trainContextSize' | 'tokenizer' | 'tokens' | 'vocabularyType'
  >;

  // embedding context 不公开实际长度；固定请求大小，避免按自适应前的上限计算预算。
  const contextSize = Math.min(cfg.maxTokens, model.trainContextSize);
  const context = await model.createEmbeddingContext({ contextSize });
  // 与 node-llama-cpp getEmbeddingFor 的首尾补齐规则一致，仅使用公开模型元数据。
  const { tokens, vocabularyType } = model;
  const beginning =
    vocabularyType === 'rwkv' || vocabularyType === 'ugm'
      ? null
      : vocabularyType === 'wpm' || tokens.shouldPrependBosToken
        ? tokens.bos
        : null;
  const ending =
    vocabularyType === 'rwkv'
      ? null
      : vocabularyType === 'wpm'
        ? tokens.sep
        : vocabularyType === 'ugm' || tokens.shouldAppendEosToken
          ? tokens.eos
          : null;

  return {
    spec,
    async embed(texts: string[], kind: EmbedKind): Promise<(Float32Array | null)[]> {
      const out: (Float32Array | null)[] = new Array(texts.length).fill(null);
      for (const [index, text] of texts.entries()) {
        if (!text.trim()) continue;
        const input = withPrefix(spec, kind, text);
        const inputTokens = model.tokenizer(input, false);
        if (inputTokens.length === 0) continue;
        const prepend = beginning != null && inputTokens[0] !== beginning ? 1 : 0;
        const append = ending != null && inputTokens.at(-1) !== ending ? 1 : 0;
        let bounded: string | typeof inputTokens = input;
        if (inputTokens.length + prepend + append > contextSize) {
          // 截断会丢掉原有结尾，所以必须重新预留结束 token；不要 detokenize 后再次分词。
          const budget = contextSize - prepend - (ending != null ? 1 : 0);
          if (budget <= 0) continue;
          bounded = inputTokens.slice(0, budget);
        }
        const embedding = await context.getEmbeddingFor(bounded);
        out[index] = finalize(Float32Array.from(embedding.vector), cfg.truncateDim);
      }
      return out;
    },
    close: () => context.dispose(),
  };
}
