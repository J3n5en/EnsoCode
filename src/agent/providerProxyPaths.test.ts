import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Message } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@shared/piAccounts', () => ({ ensureAccountProvider: vi.fn() }));

import { generate } from './imageGeneration/engine';
import { applyWorkerProxyEnv } from './proxyEnv';
import { createVirtualChooser } from './virtualClassifier';

const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  );
const close = (server: Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

async function startProxy() {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const target = new URL(req.url ?? '');
    hits.push(target.host);
    const upstream = request(target, { method: req.method, headers: req.headers }, (reply) => {
      res.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  return { url: `http://127.0.0.1:${await listen(server)}`, hits, server };
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

describe('分类器与生图请求按服务商代理发出（真实网络）', () => {
  let target: Server;
  let targetBase: string;
  let globalProxy: Awaited<ReturnType<typeof startProxy>>;
  let custom: Awaited<ReturnType<typeof startProxy>>;
  let home: string;
  const previous = getGlobalDispatcher();

  beforeAll(async () => {
    target = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
    });
    targetBase = `http://127.0.0.1:${await listen(target)}`;
    [globalProxy, custom] = await Promise.all([startProxy(), startProxy()]);
    home = mkdtempSync(path.join(tmpdir(), 'enso-proxy-paths-'));
  });

  afterAll(async () => {
    setGlobalDispatcher(previous);
    rmSync(home, { recursive: true, force: true });
    await Promise.all([target, globalProxy.server, custom.server].map(close));
  });

  beforeEach(() => {
    globalProxy.hits.length = 0;
    custom.hits.length = 0;
    applyWorkerProxyEnv({ HTTP_PROXY: globalProxy.url, http_proxy: null, NO_PROXY: '' });
  });

  it('pi-classifier 分类请求走所选服务商的代理', async () => {
    const runtime = {
      getModelsOfType: () => [{ id: 'jev' }],
      classify: async () => {
        await (await fetch(`${targetBase}/classify`)).text();
        return {
          stopReason: 'stop',
          answers: { complexity: { type: 'choice', probabilities: { complex: 1 } } },
        };
      },
    } as unknown as ModelRuntime;
    const chooser = createVirtualChooser(
      runtime,
      {
        source: 'pi-classifier',
        timeoutMs: 3000,
        classifier: {
          provider: 'typesafe',
          modelId: 'jev',
          proxy: { mode: 'custom', url: custom.url },
        },
      },
      undefined
    )!;
    const user = { role: 'user', content: 'refactor', timestamp: 0 } as Message;
    const member = { id: 'm' } as never;
    await chooser({ messages: [user], reason: 'user' } as never, {
      primary: member,
      fast: member,
      fallbacks: [],
    });
    expect(custom.hits).toEqual([new URL(targetBase).host]);
    expect(globalProxy.hits).toEqual([]);
  });

  it('生图 API 请求走所选服务商的代理；none 直连', async () => {
    const run = (proxy: { mode: 'none' } | { mode: 'custom'; url: string }) =>
      generate(
        {
          providerId: 'p',
          modelId: 'img',
          protocol: 'openai-compatible',
          baseUrl: targetBase,
          apiKey: 'k',
          proxy,
        },
        { prompt: 'cat', count: 1, referenceImages: [] },
        { cwd: home, homeDir: home, confirmOutside: async () => {} },
        'session',
        'call'
      );
    expect((await run({ mode: 'custom', url: custom.url })).items[0]?.status).toBe('success');
    expect(custom.hits).toEqual([new URL(targetBase).host]);
    expect((await run({ mode: 'none' })).items[0]?.status).toBe('success');
    expect(globalProxy.hits).toEqual([]);
  });
});
