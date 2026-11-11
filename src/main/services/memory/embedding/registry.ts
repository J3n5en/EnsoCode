import type { EmbeddingModelSpec } from './types';

export const DEFAULT_EMBEDDING_MODEL_ID = 'local:potion-multilingual-128M';
const REMOTE_PREFIX = 'remote:';
const NO_PREFIX = { passage: '', query: '' };

// 模型间差异（前缀、维度、文件、来源）全部是数据，运行时按 runtime 分派，不按模型 id 写分支。
// 前缀依据：Qwen3-Embedding 只给 query 加 instruction；BGE-M3 不需要前缀。
const REGISTRY: Record<string, EmbeddingModelSpec> = {
  [DEFAULT_EMBEDDING_MODEL_ID]: {
    id: DEFAULT_EMBEDDING_MODEL_ID,
    runtime: 'model2vec',
    dim: 256,
    prefix: NO_PREFIX,
    // 上游权重是 F32：500353 × 256 × 4 ≈ 512MB，加 18MB tokenizer.json
    approxBytes: 531_000_000,
    files: [
      {
        name: 'model.safetensors',
        sha256: '14b5eb39cb4ce5666da8ad1f3dc6be4346e9b2d601c073302fa0a31bf7943397',
      },
      { name: 'tokenizer.json' },
      { name: 'config.json' },
    ],
    sources: {
      huggingface: 'minishlab/potion-multilingual-128M',
      modelscope: 'minishlab/potion-multilingual-128M',
    },
  },
  // GGUF 走 llama.cpp，与本地 chat 共用运行时；tokenizer 内嵌，不需要额外的 tokenizer.json。
  'local:qwen3-0.6b-gguf': {
    id: 'local:qwen3-0.6b-gguf',
    runtime: 'gguf',
    // MRL 截到 512 维省一半存储；模型原生 1024，registry 可改回 null 用全维
    dim: 512,
    prefix: {
      passage: '',
      query:
        'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ',
    },
    // HF API 核对（2026-11）：Qwen3-Embedding-0.6B-Q8_0.gguf 639,150,592B
    approxBytes: 639_150_592,
    files: [{ name: 'Qwen3-Embedding-0.6B-Q8_0.gguf' }],
    gguf: { file: 'Qwen3-Embedding-0.6B-Q8_0.gguf', maxTokens: 512, truncateDim: 512 },
    sources: {
      huggingface: 'Qwen/Qwen3-Embedding-0.6B-GGUF',
      modelscope: 'Qwen/Qwen3-Embedding-0.6B-GGUF',
    },
  },
  'local:bge-m3-gguf': {
    id: 'local:bge-m3-gguf',
    runtime: 'gguf',
    // BGE-M3 不是 matryoshka 训练的，截维会明显掉点，因此用全 1024 维
    dim: 1024,
    prefix: NO_PREFIX,
    // HF API 核对（2026-11）：bge-m3-q8_0.gguf 634,553,760B
    approxBytes: 634_553_760,
    files: [{ name: 'bge-m3-q8_0.gguf' }],
    // BGE-M3 原生上下文 8192；maxTokens 只是上限，短输入计算量不变。
    // 不要写成 512：超长记忆会被静默截成前缀，开头相同的长文本向量会趋同。
    gguf: { file: 'bge-m3-q8_0.gguf', maxTokens: 8192, truncateDim: null },
    // ModelScope 同名镜像实测可直接 resolve 到 gguf（2026-11 核对 HTTP 200），HF 不可达时回退
    sources: {
      huggingface: 'ggml-org/bge-m3-Q8_0-GGUF',
      modelscope: 'ggml-org/bge-m3-Q8_0-GGUF',
    },
  },
  none: {
    id: 'none',
    runtime: 'none',
    dim: null,
    prefix: NO_PREFIX,
    approxBytes: 0,
    files: [],
    sources: null,
  },
};

export function listEmbeddingModelSpecs(): EmbeddingModelSpec[] {
  return Object.values(REGISTRY);
}

/** 未知 id 返回 null；`remote:<model>` 动态生成 openai-compatible spec。 */
export function resolveEmbeddingModelSpec(id: string): EmbeddingModelSpec | null {
  const known = REGISTRY[id];
  if (known) return known;
  if (id.startsWith(REMOTE_PREFIX) && id.length > REMOTE_PREFIX.length) {
    return {
      id,
      runtime: 'openai-compatible',
      dim: null,
      prefix: NO_PREFIX,
      approxBytes: 0,
      files: [],
      sources: null,
    };
  }
  return null;
}

/** 缓存目录名：`:` 在 Windows 不能进路径，统一替换为 `_` */
export function embeddingModelDirName(spec: EmbeddingModelSpec): string {
  return spec.id.replace(/[^a-zA-Z0-9._-]/g, '_');
}
