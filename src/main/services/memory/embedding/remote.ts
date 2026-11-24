import type { ProviderProxyConfig } from '@shared/providers/providerProxy';
import { providerProxyFetch } from '@shared/providers/providerProxyDispatcher';
import type { EmbedKind } from '../types';
import { withPrefix } from './prefix';
import type { EmbeddingModelSpec, EmbeddingProvider } from './types';

/** 凭证由接线层从既有 ModelProvider 记录取出注入；本模块不读 settings */
export interface RemoteEmbeddingOptions {
  baseUrl: string;
  apiKey: string;
  /** `remote:<model>` 里的 model；缺省从 spec.id 剥前缀 */
  model?: string;
  /** 所选服务商的独立代理；缺省跟随进程全局代理 */
  proxy?: ProviderProxyConfig;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  /** 退避基数（毫秒）；测试传 0 */
  retryDelayMs?: number;
  /** 测试注入，观察退避时长 */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
// Retry-After 上限：异常头（如 86400）会把重嵌 / capture 卡住，总尝试次数仍由 maxAttempts 约束
const MAX_RETRY_AFTER_MS = 60_000;
const REMOTE_PREFIX = 'remote:';

export function remoteModelName(spec: EmbeddingModelSpec, override?: string): string {
  return (
    override ?? (spec.id.startsWith(REMOTE_PREFIX) ? spec.id.slice(REMOTE_PREFIX.length) : spec.id)
  );
}

export function embeddingsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return /\/v\d+$/.test(base) ? `${base}/embeddings` : `${base}/v1/embeddings`;
}

/** OpenAI-compatible `/v1/embeddings`；维度由首次成功响应探测，之后 spec.dim 固定 */
export function createRemoteEmbeddingProvider(
  spec: EmbeddingModelSpec,
  opts: RemoteEmbeddingOptions
): EmbeddingProvider {
  const doFetch = opts.fetch ?? providerProxyFetch(opts.proxy) ?? fetch;
  const url = embeddingsUrl(opts.baseUrl);
  const model = remoteModelName(spec, opts.model);
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const delayBase = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const sleep = opts.sleep ?? defaultSleep;
  let dim: number | null = spec.dim;

  async function request(inputs: string[]): Promise<number[][]> {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify({ model, input: inputs }),
          signal: ac.signal,
        });
        if (res.status === 429 || res.status >= 500) {
          lastError = new Error(`embeddings HTTP ${res.status}`);
          const retryAfter = Number(res.headers.get('retry-after'));
          await sleep(
            Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS)
              : delayBase * 2 ** attempt
          );
          continue;
        }
        if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
        return parseEmbeddings(await res.json(), inputs.length);
      } catch (error) {
        // 4xx（非 429）与解析错误不重试；网络/超时重试
        if (error instanceof Error && /HTTP 4\d\d|malformed/.test(error.message)) throw error;
        lastError = error;
        await sleep(delayBase * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('embeddings request failed');
  }

  return {
    get spec() {
      return { ...spec, dim };
    },
    async embed(texts: string[], kind: EmbedKind) {
      const out: (Float32Array | null)[] = new Array(texts.length).fill(null);
      const indices: number[] = [];
      const inputs: string[] = [];
      texts.forEach((t, i) => {
        if (t.trim()) {
          indices.push(i);
          inputs.push(withPrefix(spec, kind, t));
        }
      });
      if (inputs.length === 0) return out;
      const vectors = await request(inputs);
      vectors.forEach((v, j) => {
        if (dim === null) dim = v.length;
        // 维度漂移的向量不落库：与已存向量不可比
        if (v.length !== dim || v.length === 0) return;
        out[indices[j]] = Float32Array.from(v);
      });
      return out;
    },
  };
}

function parseEmbeddings(body: unknown, expected: number): number[][] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || data.length !== expected) {
    throw new Error('embeddings response malformed: data length mismatch');
  }
  const rows: number[][] = new Array(expected);
  data.forEach((item, i) => {
    const e = item as { embedding?: unknown; index?: unknown };
    if (!Array.isArray(e.embedding) || !e.embedding.every((x) => typeof x === 'number')) {
      throw new Error('embeddings response malformed: embedding is not number[]');
    }
    const at = typeof e.index === 'number' ? e.index : i;
    // 越界 / 重复的 index 会留下稀疏洞，后续 `v.length` 直接抛；当作坏响应拒掉
    if (!Number.isInteger(at) || at < 0 || at >= expected || rows[at] !== undefined) {
      throw new Error(`embeddings response malformed: bad index ${String(e.index)}`);
    }
    rows[at] = e.embedding as number[];
  });
  return rows;
}

function defaultSleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}
