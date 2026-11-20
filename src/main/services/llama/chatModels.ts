import path from 'node:path';
import { isModelReady } from '../memory/embedding/downloader';

/**
 * 本地 chat 模型注册表。与 embedding 那套同构：差异全是数据，运行时不按 id 写分支。
 * 文件 / 来源形状满足 DownloadableModel，直接复用 embedding/downloader。
 */

export const REMOTE_CHAT_MODEL_ID = 'remote';
export const DEFAULT_CHAT_MODEL_ID = REMOTE_CHAT_MODEL_ID;

export interface ChatModelSpec {
  id: string;
  label: string;
  /** 参数量提示，UI 用来说明速度/质量取舍 */
  params: string;
  /**
   * llama.cpp 实际分配的 KV 大小。Gemma 4 训练窗口远大于此；
   * 本地再开一份全窗口会把 embedding 槽挤掉。
   */
  contextSize: number;
  approxBytes: number;
  files: { name: string; sha256?: string }[];
  sources: { huggingface: string | null; modelscope: string | null } | null;
}

const REGISTRY: Record<string, ChatModelSpec> = {
  [REMOTE_CHAT_MODEL_ID]: {
    id: REMOTE_CHAT_MODEL_ID,
    label: 'Remote',
    params: '',
    contextSize: 0,
    approxBytes: 0,
    files: [],
    sources: null,
  },
  // 实测提炼耗时（M 系列 Metal，4000 字符输入 ≈ 一个 DISTILL_MAX_CHUNK_CHARS 块，
  // 已关闭 CoT——见 chatWrapper.ts；2026-09-10）：
  //   qwen3-1.7B    8.3-9.4s   ← 最快，且只有 1.1GB
  //   gemma-4-E2B  14.9-16.5s
  // 未关 CoT 时分别是 42-73s 和 28-65s，差一个数量级。
  //
  // 体积梯度：提炼是结构化抽取，小模型也能胜任，不该让所有人都下 3GB。
  // 全部 unsloth 的 UD-Q4_K_XL；size 与 sha256 取自 HF tree API 的 lfs.oid（2026-11 核对）。
  'local:qwen3-0.6b-chat': {
    id: 'local:qwen3-0.6b-chat',
    label: 'Qwen3 0.6B',
    params: '0.6B',
    contextSize: 8192,
    approxBytes: 405_372_608,
    files: [
      {
        name: 'Qwen3-0.6B-UD-Q4_K_XL.gguf',
        sha256: 'ed2dd561f8aa5651cfb198be583269779e26ca6e28c40dba94fc2da4432bde2a',
      },
    ],
    sources: {
      huggingface: 'unsloth/Qwen3-0.6B-GGUF',
      modelscope: 'unsloth/Qwen3-0.6B-GGUF',
    },
  },
  'local:qwen3-1.7b': {
    id: 'local:qwen3-1.7b',
    label: 'Qwen3 1.7B',
    params: '1.7B',
    contextSize: 8192,
    approxBytes: 1_132_952_128,
    files: [
      {
        name: 'Qwen3-1.7B-UD-Q4_K_XL.gguf',
        sha256: '01977643b1d7292d09eb6ef75c7af8b084a3bbf2cb4e1d128ab76adeb8d75490',
      },
    ],
    sources: {
      huggingface: 'unsloth/Qwen3-1.7B-GGUF',
      modelscope: 'unsloth/Qwen3-1.7B-GGUF',
    },
  },
  'local:qwen3-4b-instruct': {
    id: 'local:qwen3-4b-instruct',
    label: 'Qwen3 4B Instruct',
    params: '4B',
    contextSize: 8192,
    approxBytes: 2_546_340_960,
    files: [
      {
        name: 'Qwen3-4B-Instruct-2507-UD-Q4_K_XL.gguf',
        sha256: '4bbe1f2f8ebe69fad3be8e15d69f220b06448a9dd26f82d7d81cce88ebfc39fd',
      },
    ],
    sources: {
      huggingface: 'unsloth/Qwen3-4B-Instruct-2507-GGUF',
      modelscope: 'unsloth/Qwen3-4B-Instruct-2507-GGUF',
    },
  },
  'local:gemma3-4b': {
    id: 'local:gemma3-4b',
    label: 'Gemma 3 4B',
    params: '4B',
    contextSize: 8192,
    approxBytes: 2_544_288_896,
    files: [
      {
        name: 'gemma-3-4b-it-UD-Q4_K_XL.gguf',
        sha256: 'c05bd745da387bf9200ffa7070665305d886d5093638c4f8b6c3862ea26ca8aa',
      },
    ],
    sources: {
      huggingface: 'unsloth/gemma-3-4b-it-GGUF',
      modelscope: 'unsloth/gemma-3-4b-it-GGUF',
    },
  },
  'local:gemma-4-e2b': {
    id: 'local:gemma-4-e2b',
    label: 'Gemma 4 E2B IT',
    params: 'E2B',
    contextSize: 8192,
    // HF tree API 核对（2026-09-10）：gemma-4-E2B-it-UD-Q4_K_XL.gguf = 3,184,496,736 B
    approxBytes: 3_184_496_736,
    files: [
      {
        name: 'gemma-4-E2B-it-UD-Q4_K_XL.gguf',
        // LFS oid = 文件内容 sha256
        sha256: 'b52f438017efaec5debf1c0d8be690571e212a07c312f1102bbce927258cfc32',
      },
    ],
    sources: {
      huggingface: 'unsloth/gemma-4-E2B-it-GGUF',
      modelscope: 'unsloth/gemma-4-E2B-it-GGUF',
    },
  },
};

export function listChatModelSpecs(): ChatModelSpec[] {
  return Object.values(REGISTRY);
}

export function resolveChatModelSpec(id: string): ChatModelSpec | null {
  return REGISTRY[id] ?? null;
}

/** 缓存目录名：`:` 在 Windows 不能进路径，统一替换为 `_` */
export function chatModelDirName(spec: ChatModelSpec): string {
  return spec.id.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function chatModelIdFromSettings(state: Record<string, unknown> | undefined): string {
  const raw = state?.memoryChatModel;
  if (typeof raw !== 'string' || !raw) return DEFAULT_CHAT_MODEL_ID;
  return resolveChatModelSpec(raw) ? raw : DEFAULT_CHAT_MODEL_ID;
}

function safeJoin(dir: string, name: string): string {
  const resolved = path.resolve(dir, name);
  const root = path.resolve(dir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`chat model file escapes model dir: ${name}`);
  }
  return resolved;
}

export function chatModelDir(modelsRoot: string, spec: ChatModelSpec): string {
  return path.join(modelsRoot, chatModelDirName(spec));
}

/** 由模型 id 推导 GGUF 路径；未知 / 远程 / 无文件返回 null。Renderer 不得传磁盘路径。 */
export function resolveChatModelFile(modelsRoot: string, modelId: string): string | null {
  const spec = resolveChatModelSpec(modelId);
  if (!spec || spec.files.length === 0) return null;
  return safeJoin(chatModelDir(modelsRoot, spec), spec.files[0].name);
}

/** 下载完成（`.ready` + 文件齐全）才给推理用；未就绪返回 null，让任务保持 pending。 */
export function localChatModelPathIfReady(modelsRoot: string, modelId: string): string | null {
  const spec = resolveChatModelSpec(modelId);
  if (!spec || spec.files.length === 0) return null;
  const dir = chatModelDir(modelsRoot, spec);
  if (!isModelReady(dir, spec)) return null;
  return resolveChatModelFile(modelsRoot, modelId);
}
