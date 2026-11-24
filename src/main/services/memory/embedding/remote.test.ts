import { describe, expect, it } from 'vitest';
import { createRemoteEmbeddingProvider, embeddingsUrl, remoteModelName } from './remote';
import type { EmbeddingModelSpec } from './types';

const spec: EmbeddingModelSpec = {
  id: 'remote:text-embedding-3-small',
  runtime: 'openai-compatible',
  dim: null,
  files: [],
  sources: null,
  approxBytes: 0,
  prefix: { passage: '', query: 'query: ' },
};

type Call = { url: string; body: { model: string; input: string[] }; auth: string | null };
function fakeFetch(responses: (() => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
      auth: new Headers(init?.headers).get('authorization'),
    });
    const next = responses.shift();
    if (!next) throw new TypeError('fetch failed');
    return next();
  };
  return { fetchImpl, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const ok = (vectors: number[][]) =>
  json({ data: vectors.map((embedding, index) => ({ embedding, index })) });

describe('remote embedding helpers', () => {
  it('derives the model name from the registry id and builds /v1/embeddings', () => {
    expect(remoteModelName(spec)).toBe('text-embedding-3-small');
    expect(remoteModelName(spec, 'override')).toBe('override');
    expect(embeddingsUrl('https://api.openai.com/v1/')).toBe(
      'https://api.openai.com/v1/embeddings'
    );
    expect(embeddingsUrl('https://host.example')).toBe('https://host.example/v1/embeddings');
  });
});

describe('createRemoteEmbeddingProvider', () => {
  it('posts prefixed inputs with bearer auth, probes dim from the first response, skips blanks', async () => {
    const { fetchImpl, calls } = fakeFetch([
      () =>
        ok([
          [3, 4],
          [0, 1],
        ]),
    ]);
    const p = createRemoteEmbeddingProvider(spec, {
      baseUrl: 'https://x.test/v1',
      apiKey: 'sk-1',
      fetch: fetchImpl,
      retryDelayMs: 0,
    });
    expect(p.spec.dim).toBeNull();
    const [a, blank, b] = await p.embed(['alpha', '   ', 'beta'], 'query');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'https://x.test/v1/embeddings',
      auth: 'Bearer sk-1',
      body: { model: 'text-embedding-3-small', input: ['query: alpha', 'query: beta'] },
    });
    expect(Array.from(a as Float32Array)).toEqual([3, 4]);
    expect(blank).toBeNull();
    expect(Array.from(b as Float32Array)).toEqual([0, 1]);
    expect(p.spec.dim).toBe(2);
  });

  it('does not call the network for an all-blank batch', async () => {
    const { fetchImpl, calls } = fakeFetch([]);
    const p = createRemoteEmbeddingProvider(spec, { baseUrl: 'u', apiKey: 'k', fetch: fetchImpl });
    expect(await p.embed(['', ' '], 'passage')).toEqual([null, null]);
    expect(calls).toHaveLength(0);
  });

  it('respects the index field when the server reorders data', async () => {
    const { fetchImpl } = fakeFetch([
      () =>
        json({
          data: [
            { embedding: [0, 1], index: 1 },
            { embedding: [1, 0], index: 0 },
          ],
        }),
    ]);
    const p = createRemoteEmbeddingProvider(spec, { baseUrl: 'u', apiKey: 'k', fetch: fetchImpl });
    const [a, b] = await p.embed(['a', 'b'], 'passage');
    expect(Array.from(a as Float32Array)).toEqual([1, 0]);
    expect(Array.from(b as Float32Array)).toEqual([0, 1]);
  });

  it('retries 429 / 5xx / network errors with backoff, then succeeds', async () => {
    const { fetchImpl, calls } = fakeFetch([
      () => json({ error: 'slow down' }, 429, { 'retry-after': '0' }),
      () => json({}, 503),
      () => {
        throw new TypeError('fetch failed');
      },
      () => ok([[1]]),
    ]);
    const p = createRemoteEmbeddingProvider(spec, {
      baseUrl: 'u',
      apiKey: 'k',
      fetch: fetchImpl,
      retryDelayMs: 0,
      maxAttempts: 4,
    });
    const [v] = await p.embed(['x'], 'passage');
    expect(Array.from(v as Float32Array)).toEqual([1]);
    expect(calls).toHaveLength(4);
  });

  it('Retry-After 被 clamp 到 ≤ 60s，异常头不能把重嵌 / capture 卡很久（3b Minor 1）', async () => {
    const sleeps: number[] = [];
    const { fetchImpl } = fakeFetch([
      () => json({}, 429, { 'retry-after': '86400' }),
      () => json({}, 503, { 'retry-after': '-5' }),
      () => ok([[1, 0]]),
    ]);
    const p = createRemoteEmbeddingProvider(spec, {
      baseUrl: 'https://x.test',
      apiKey: 'k',
      fetch: fetchImpl,
      retryDelayMs: 7,
      maxAttempts: 3,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await p.embed(['a'], 'passage');
    // 第一次：头超上限 → 60s；第二次：非法头 → 退避基数 7*2^1
    expect(sleeps).toEqual([60_000, 14]);
  });

  it('拒绝 index 越界 / 重复的响应项，不产生稀疏洞（3b Minor 2）', async () => {
    for (const data of [
      [
        { embedding: [1, 0], index: 0 },
        { embedding: [0, 1], index: 5 },
      ],
      [
        { embedding: [1, 0], index: -1 },
        { embedding: [0, 1], index: 1 },
      ],
      [
        { embedding: [1, 0], index: 0 },
        { embedding: [0, 1], index: 0 },
      ],
    ]) {
      const { fetchImpl } = fakeFetch([() => json({ data })]);
      const p = createRemoteEmbeddingProvider(spec, {
        baseUrl: 'https://x.test',
        apiKey: 'k',
        fetch: fetchImpl,
        retryDelayMs: 0,
      });
      await expect(p.embed(['a', 'b'], 'passage')).rejects.toThrow(/malformed/);
    }
  });

  it('gives up after maxAttempts and surfaces the last error', async () => {
    const { fetchImpl, calls } = fakeFetch([() => json({}, 500), () => json({}, 502)]);
    const p = createRemoteEmbeddingProvider(spec, {
      baseUrl: 'u',
      apiKey: 'k',
      fetch: fetchImpl,
      retryDelayMs: 0,
      maxAttempts: 2,
    });
    await expect(p.embed(['x'], 'passage')).rejects.toThrow(/HTTP 502/);
    expect(calls).toHaveLength(2);
  });

  it('does not retry 401 or malformed bodies', async () => {
    const bad = fakeFetch([() => json({}, 401), () => ok([[1]])]);
    const p = createRemoteEmbeddingProvider(spec, {
      baseUrl: 'u',
      apiKey: 'k',
      fetch: bad.fetchImpl,
      retryDelayMs: 0,
    });
    await expect(p.embed(['x'], 'passage')).rejects.toThrow(/HTTP 401/);
    expect(bad.calls).toHaveLength(1);

    const malformed = fakeFetch([() => json({ data: [{ embedding: 'nope' }] }), () => ok([[1]])]);
    const q = createRemoteEmbeddingProvider(spec, {
      baseUrl: 'u',
      apiKey: 'k',
      fetch: malformed.fetchImpl,
      retryDelayMs: 0,
    });
    await expect(q.embed(['x'], 'passage')).rejects.toThrow(/malformed/);
    expect(malformed.calls).toHaveLength(1);
  });

  it('aborts a hanging request after timeoutMs', async () => {
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError'))
        );
      });
    const p = createRemoteEmbeddingProvider(spec, {
      baseUrl: 'u',
      apiKey: 'k',
      fetch: fetchImpl,
      timeoutMs: 5,
      retryDelayMs: 0,
      maxAttempts: 1,
    });
    await expect(p.embed(['x'], 'passage')).rejects.toThrow(/aborted/);
  });

  it('drops vectors whose dim drifts from the probed dim', async () => {
    const { fetchImpl } = fakeFetch([() => ok([[1, 0]]), () => ok([[1, 0, 0]])]);
    const p = createRemoteEmbeddingProvider(spec, { baseUrl: 'u', apiKey: 'k', fetch: fetchImpl });
    await p.embed(['a'], 'passage');
    expect(await p.embed(['b'], 'passage')).toEqual([null]);
    expect(p.spec.dim).toBe(2);
  });
});

describe('remote embedding 服务商代理', () => {
  it('配置了独立代理时经该代理发送（真实网络）', async () => {
    const { createServer, request } = await import('node:http');
    const hits: string[] = [];
    const target = createServer((req, res) => {
      req.resume();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }));
    });
    const proxy = createServer((req, res) => {
      const url = new URL(req.url ?? '');
      hits.push(url.host);
      const upstream = request(url, { method: req.method, headers: req.headers }, (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      });
      req.pipe(upstream);
    });
    const listen = (server: typeof target) =>
      new Promise<number>((resolve) =>
        server.listen(0, '127.0.0.1', () =>
          resolve((server.address() as import('node:net').AddressInfo).port)
        )
      );
    const targetPort = await listen(target);
    const proxyPort = await listen(proxy);
    try {
      const provider = createRemoteEmbeddingProvider(spec, {
        baseUrl: `http://127.0.0.1:${targetPort}/v1`,
        apiKey: 'k',
        proxy: { mode: 'custom', url: `http://127.0.0.1:${proxyPort}` },
        retryDelayMs: 0,
        maxAttempts: 1,
      });
      const [vector] = await provider.embed(['hello'], 'query');
      expect(Array.from(vector ?? [])).toEqual([1, 2]);
      expect(hits).toEqual([`127.0.0.1:${targetPort}`]);
    } finally {
      for (const server of [target, proxy]) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    }
  });
});
