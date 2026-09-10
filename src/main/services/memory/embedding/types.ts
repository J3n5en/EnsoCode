import type { EmbedKind } from '../types';

export type EmbeddingRuntime = 'model2vec' | 'gguf' | 'openai-compatible' | 'none';

export interface EmbeddingModelFile {
  name: string;
  /** 已知时下载完成后校验；缺省只校验长度 */
  sha256?: string;
}

export interface EmbeddingModelSpec {
  id: string;
  runtime: EmbeddingRuntime;
  /** remote 模型维度由首个响应决定，注册表里为 null */
  dim: number | null;
  /** 写入 / 查询前缀；空串表示该模型不加前缀 */
  prefix: { passage: string; query: string };
  approxBytes: number;
  files: EmbeddingModelFile[];
  /** llama.cpp 运行时参数；其它 runtime 为 undefined */
  gguf?: {
    file: string;
    /** 上下文上限；池化策略由 GGUF 元数据决定，无需在这里指定 */
    maxTokens: number;
    /** MRL 截断：取前 N 维再重新归一化；null 用全维 */
    truncateDim: number | null;
  };
  /** 仓库 id；HuggingFace 主源，ModelScope 为中国区镜像回退 */
  sources: { huggingface: string; modelscope: string | null } | null;
}

export interface EmbeddingProvider {
  readonly spec: EmbeddingModelSpec;
  /** 每个输入对应一个向量；空输入 / 无可用 token 返回 null（调用方按「无向量」处理，不落零向量） */
  embed(texts: string[], kind: EmbedKind): Promise<(Float32Array | null)[]>;
  close?(): void | Promise<void>;
  setIdleMinutes?(minutes: number): void;
}
