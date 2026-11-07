import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApprovalRequestInfo } from '@shared/types/agent';
import { expect, it, vi } from 'vitest';
import { ApprovalGate } from '../approval';
import { confirmImageReference, createImageGenTool } from './imageGen';

it('SSH 会话在 full 档上传本机参考图仍要真人确认，本地 full 档照常放行', async () => {
  const requests: ApprovalRequestInfo[] = [];
  const gate = new ApprovalGate(
    'full',
    (info) => {
      requests.push(info);
      gate.respond(info.requestId, 'deny');
    },
    () => undefined
  );
  await expect(confirmImageReference(gate, false)('/x.png', undefined, 'c1')).resolves.toBe(
    undefined
  );
  expect(requests).toHaveLength(0);
  await expect(confirmImageReference(gate, true)('/x.png', undefined, 'c2')).rejects.toThrow();
  expect(requests).toHaveLength(1);
  expect(requests[0].protected).toBe('external-send');
});

it('fake-ip 代理解析出的 198.18/15 地址可以下载结果图', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-gen-'));
  try {
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const fetch = vi.fn(async (url: string, _init: RequestInit) =>
      url.includes('/images/generations')
        ? new Response(JSON.stringify({ data: [{ url: 'https://public.example/image' }] }))
        : new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } })
    );
    const tool = createImageGenTool({
      cwd: root,
      homeDir: root,
      confirmOutside: async () => {},
      fetch,
      lookup: async () => ['198.18.0.12'],
      getConfig: () => ({
        config: {
          providerId: 'p',
          modelId: 'm',
          protocol: 'openai-compatible',
          baseUrl: 'http://localhost/v1',
          apiKey: 'secret',
        },
      }),
    });
    const result = await tool.execute('id', { prompt: 'x' } as never, undefined, undefined, {
      sessionManager: { getSessionId: () => 's' },
    } as never);
    expect(JSON.parse((result.content[0] as { text: string }).text).items[0].status).toBe(
      'success'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('Gemini 第一张落盘后取消：保留已完成文件，剩余项 cancelled 且不再发请求', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-gen-partial-cancel-'));
  const controller = new AbortController();
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  let calls = 0;
  const fetch = vi.fn(async () => {
    if (++calls === 2) controller.abort();
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ inlineData: { mimeType: 'image/png', data: png.toString('base64') } }],
            },
          },
        ],
      })
    );
  });
  try {
    const tool = createImageGenTool({
      cwd: root,
      homeDir: root,
      confirmOutside: async () => {},
      fetch,
      getConfig: () => ({
        config: {
          providerId: 'p',
          modelId: 'm',
          protocol: 'gemini',
          baseUrl: 'http://localhost/v1beta',
          apiKey: 'secret',
        },
      }),
    });
    const result = await tool.execute(
      'id',
      { prompt: 'x', count: 3 } as never,
      controller.signal,
      undefined,
      { sessionManager: { getSessionId: () => 's' } } as never
    );
    const { items } = JSON.parse((result.content[0] as { text: string }).text);
    expect(items.map((item: { status: string }) => item.status)).toEqual([
      'success',
      'cancelled',
      'cancelled',
    ]);
    expect(readFileSync(items[0].path).equals(png)).toBe(true);
    expect(result.content.filter((part) => part.type === 'image')).toEqual([
      { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
    ]);
    expect(items.slice(1).every((item: { path: unknown }) => item.path === null)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(readdirSync(join(root, '.pi', 'scratch', 's'))).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('SSH 远端 cwd 即使碰巧存在于本机，也不能免审批上传本机参考图', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-gen-ssh-approval-'));
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const confirmOutside = vi.fn(async () => {
    throw new Error('denied');
  });
  const fetch = vi.fn(
    async () => new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
  );
  try {
    writeFileSync(join(root, 'local.png'), png);
    const deps = {
      cwd: root,
      remote: true,
      homeDir: root,
      confirmOutside,
      fetch,
      getConfig: () => ({
        config: {
          providerId: 'p',
          modelId: 'm',
          protocol: 'openai' as const,
          baseUrl: 'http://localhost/v1',
          apiKey: 'secret',
        },
      }),
    };
    const tool = createImageGenTool(deps);
    const result = await tool.execute(
      'id',
      { prompt: 'x', referenceImages: ['local.png'] } as never,
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => 's' } } as never
    );
    expect(confirmOutside).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('等待供应商期间 session 目录被换成 junction 时不向链接目标写入', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-gen-directory-swap-'));
  const outside = mkdtempSync(join(tmpdir(), 'image-gen-directory-target-'));
  const sessionDir = join(root, '.pi', 'scratch', 's');
  try {
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const fetch = vi.fn(async () => {
      rmSync(sessionDir, { recursive: true });
      symlinkSync(outside, sessionDir, process.platform === 'win32' ? 'junction' : 'dir');
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
    });
    const tool = createImageGenTool({
      cwd: root,
      homeDir: root,
      confirmOutside: async () => {},
      fetch,
      getConfig: () => ({
        config: {
          providerId: 'p',
          modelId: 'm',
          protocol: 'openai',
          baseUrl: 'http://localhost/v1',
          apiKey: 'secret',
        },
      }),
    });
    const result = await tool.execute('id', { prompt: 'x' } as never, undefined, undefined, {
      sessionManager: { getSessionId: () => 's' },
    } as never);
    expect(result.isError).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

it('默认真实网络 transport 能提交 JSON 和 multipart，而非仅在 mock fetch 下工作', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-gen-transport-'));
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const captured: Array<{ url: string; contentType: string; body: string }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    captured.push({
      url: request.url ?? '',
      contentType: request.headers['content-type'] ?? '',
      body: Buffer.concat(chunks).toString(),
    });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    writeFileSync(join(root, 'ref.png'), png);
    const tool = createImageGenTool({
      cwd: root,
      homeDir: root,
      confirmOutside: async () => {},
      getConfig: () => ({
        config: {
          providerId: 'p',
          modelId: 'm',
          protocol: 'openai-compatible',
          baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/custom/v1`,
          apiKey: 'fixture-key',
        },
      }),
    });
    const run = (referenceImages: string[]) =>
      tool.execute('id', { prompt: 'draw', referenceImages } as never, undefined, undefined, {
        sessionManager: { getSessionId: () => 's' },
      } as never);
    expect((await run([])).isError).toBeFalsy();
    expect((await run(['ref.png'])).isError).toBeFalsy();
    expect(captured[0]).toMatchObject({
      url: '/custom/v1/images/generations',
      contentType: 'application/json',
    });
    expect(JSON.parse(captured[0].body)).toEqual({ model: 'm', prompt: 'draw', n: 1 });
    expect(captured[1].url).toBe('/custom/v1/images/edits');
    expect(captured[1].contentType).toContain('multipart/form-data; boundary=');
    expect(captured[1].body).toContain('name="image[]"');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    rmSync(root, { recursive: true, force: true });
  }
});

it('第二张图片写到一半失败时删除半成品，保留首张成功图片', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-gen-write-'));
  const probe = await open(join(root, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const write = probe.writeFile;
  await probe.close();
  let calls = 0;
  const spy = vi.spyOn(prototype, 'writeFile').mockImplementation(async function (
    this: FileHandle,
    data,
    options
  ) {
    if (++calls === 2) {
      await write.call(this, Buffer.from('partial'));
      throw new Error('fixture write failure');
    }
    await write.call(this, data, options);
  });
  try {
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ b64_json: png.toString('base64') }, { b64_json: png.toString('base64') }],
          })
        )
    );
    const tool = createImageGenTool({
      cwd: root,
      homeDir: root,
      confirmOutside: async () => {},
      fetch,
      getConfig: () => ({
        config: {
          providerId: 'p',
          modelId: 'm',
          protocol: 'openai',
          baseUrl: 'http://localhost/v1',
          apiKey: 'secret',
        },
      }),
    });
    const result = await tool.execute(
      'id',
      { prompt: 'x', count: 2 } as never,
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => 's' } } as never
    );
    const { items } = JSON.parse((result.content[0] as { text: string }).text);
    expect(items[0].status).toBe('success');
    expect(items[1]).toEqual({ index: 2, status: 'error', path: null, mimeType: null });
    expect(readFileSync(items[0].path).equals(png)).toBe(true);
    expect(readdirSync(join(root, '.pi', 'scratch', 's'))).toHaveLength(1);
  } finally {
    spy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

it('生成的图片落盘并返回会话图片附件，JSON 回执保留四字段和失败项', async () => {
  const home = mkdtempSync(join(tmpdir(), 'image-gen-'));
  try {
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
    );
    const tool = createImageGenTool({
      cwd: home,
      homeDir: home,
      confirmOutside: async () => {},
      fetch,
      getConfig: () => ({
        config: {
          providerId: 'p',
          modelId: 'm',
          protocol: 'openai',
          baseUrl: 'http://localhost/v1',
          apiKey: 'secret',
        },
      }),
    });
    const result = await tool.execute(
      'call',
      { prompt: 'hello', count: 2 } as never,
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => 'session-1' } } as never
    );
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({ index: 1, status: 'success', mimeType: 'image/png' });
    expect(Object.keys(body.items[0]).sort()).toEqual(['index', 'mimeType', 'path', 'status']);
    expect(readFileSync(body.items[0].path)).toEqual(png);
    expect(body.items[1]).toEqual({ index: 2, status: 'error', path: null, mimeType: null });
    expect(result.content.slice(1)).toEqual([
      { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
    ]);
    expect(body).not.toHaveProperty('images');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it('直接调用拒绝脏参数和外部图片审批拒绝', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-gen-'));
  try {
    const file = join(root, 'ref.png');
    writeFileSync(file, Buffer.from('89504e470d0a1a0a00000000', 'hex'));
    const fetch = vi.fn();
    const confirmOutside = vi.fn(async () => {
      throw new Error('denied');
    });
    const tool = createImageGenTool({
      cwd: tmpdir(),
      homeDir: root,
      confirmOutside,
      fetch,
      getConfig: () => ({
        config: {
          providerId: 'p',
          modelId: 'm',
          protocol: 'openai',
          baseUrl: 'http://localhost/v1',
          apiKey: 'secret',
        },
      }),
    });
    const run = (args: unknown) =>
      tool.execute('id', args as never, undefined, undefined, {
        sessionManager: { getSessionId: () => 's' },
      } as never);
    expect((await run({ prompt: 'x', extra: true })).isError).toBe(true);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const tool2 = createImageGenTool({
      cwd: workspace,
      homeDir: root,
      confirmOutside,
      fetch,
      getConfig: () => ({
        config: {
          providerId: 'p',
          modelId: 'm',
          protocol: 'openai',
          baseUrl: 'http://localhost/v1',
          apiKey: 'secret',
        },
      }),
    });
    const result = await tool2.execute(
      'id',
      { prompt: 'x', referenceImages: [file] } as never,
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => 's' } } as never
    );
    expect(result.isError).toBe(true);
    expect(confirmOutside).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('Gemini 每张独立请求并忽略 thought 图片', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-gen-'));
  try {
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const fetch = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      thought: true,
                      inlineData: { mimeType: 'image/png', data: png.toString('base64') },
                    },
                    { inlineData: { mimeType: 'image/png', data: png.toString('base64') } },
                  ],
                },
              },
            ],
          })
        )
    );
    const tool = createImageGenTool({
      cwd: root,
      homeDir: root,
      confirmOutside: async () => {},
      fetch,
      getConfig: () => ({
        config: {
          providerId: 'p',
          modelId: 'a/b',
          protocol: 'gemini',
          baseUrl: 'http://localhost/v1',
          apiKey: 'secret',
        },
      }),
    });
    const result = await tool.execute(
      'id',
      { prompt: 'x', count: 2 } as never,
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => 's' } } as never
    );
    expect(
      JSON.parse((result.content[0] as { text: string }).text).items.map(
        (x: { status: string }) => x.status
      )
    ).toEqual(['success', 'success']);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0]).toContain('a%2Fb:generateContent');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('兼容接口拒绝指向内网的下载重定向且不发送凭证', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-gen-'));
  try {
    const fetch = vi.fn(async (url: string, _init: RequestInit) =>
      url.includes('/images/generations')
        ? new Response(JSON.stringify({ data: [{ url: 'https://public.example/image' }] }))
        : new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } })
    );
    const tool = createImageGenTool({
      cwd: root,
      homeDir: root,
      confirmOutside: async () => {},
      fetch,
      lookup: async () => ['8.8.8.8'],
      getConfig: () => ({
        config: {
          providerId: 'p',
          modelId: 'm',
          protocol: 'openai-compatible',
          baseUrl: 'http://localhost/v1',
          apiKey: 'secret',
        },
      }),
    });
    const result = await tool.execute('id', { prompt: 'x' } as never, undefined, undefined, {
      sessionManager: { getSessionId: () => 's' },
    } as never);
    expect(JSON.parse((result.content[0] as { text: string }).text).items[0].status).toBe('error');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].headers).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('secret');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('已经取消的调用不发请求并返回 cancelled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-gen-'));
  try {
    const fetch = vi.fn();
    const tool = createImageGenTool({
      cwd: root,
      homeDir: root,
      confirmOutside: async () => {},
      fetch,
      getConfig: () => ({
        config: {
          providerId: 'p',
          modelId: 'm',
          protocol: 'openai',
          baseUrl: 'http://localhost/v1',
          apiKey: 'secret',
        },
      }),
    });
    const controller = new AbortController();
    controller.abort();
    const result = await tool.execute(
      'id',
      { prompt: 'x' } as never,
      controller.signal,
      undefined,
      { sessionManager: { getSessionId: () => 's' } } as never
    );
    expect(JSON.parse((result.content[0] as { text: string }).text).items[0]).toEqual({
      index: 1,
      status: 'cancelled',
      path: null,
      mimeType: null,
    });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('scratch 目录是 junction 时拒绝写入', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-gen-'));
  try {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    const home = join(root, 'home');
    mkdirSync(home);
    symlinkSync(outside, join(home, '.pi'), 'junction');
    const fetch = vi.fn();
    const tool = createImageGenTool({
      cwd: root,
      homeDir: home,
      confirmOutside: async () => {},
      fetch,
      getConfig: () => ({
        config: {
          providerId: 'p',
          modelId: 'm',
          protocol: 'openai',
          baseUrl: 'http://localhost/v1',
          apiKey: 'secret',
        },
      }),
    });
    const result = await tool.execute('id', { prompt: 'x' } as never, undefined, undefined, {
      sessionManager: { getSessionId: () => 's' },
    } as never);
    expect(result.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('并发调用写入不同文件，配置在每次调用起始快照', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-gen-'));
  try {
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const fetch = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
    );
    const getConfig = vi.fn(() => ({
      config: {
        providerId: 'p',
        modelId: 'm',
        protocol: 'openai' as const,
        baseUrl: 'http://localhost/v1',
        apiKey: 'secret',
      },
    }));
    const tool = createImageGenTool({
      cwd: root,
      homeDir: root,
      confirmOutside: async () => {},
      fetch,
      getConfig,
    });
    const run = () =>
      tool.execute('id', { prompt: 'x' } as never, undefined, undefined, {
        sessionManager: { getSessionId: () => 's' },
      } as never);
    const results = await Promise.all([run(), run()]);
    const paths = results.map(
      (r) => JSON.parse((r.content[0] as { text: string }).text).items[0].path
    );
    expect(paths[0]).not.toEqual(paths[1]);
    expect(readFileSync(paths[0])).toEqual(png);
    expect(readFileSync(paths[1])).toEqual(png);
    expect(getConfig).toHaveBeenCalledTimes(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('HTTP 错误返回状态码且不泄露响应和密钥', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-gen-'));
  try {
    const fetch = vi.fn(async () => new Response('secret raw response', { status: 429 }));
    const tool = createImageGenTool({
      cwd: root,
      homeDir: root,
      confirmOutside: async () => {},
      fetch,
      getConfig: () => ({
        config: {
          providerId: 'p',
          modelId: 'm',
          protocol: 'openai',
          baseUrl: 'http://localhost/v1',
          apiKey: 'secret',
        },
      }),
    });
    const result = await tool.execute('id', { prompt: 'x' } as never, undefined, undefined, {
      sessionManager: { getSessionId: () => 's' },
    } as never);
    expect(JSON.stringify(result)).toContain('429');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('raw response');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('参考图以 multipart 发送给 edits，生成结果可再次使用', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-gen-'));
  try {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    writeFileSync(join(workspace, 'ref.png'), png);
    const confirmOutside = vi.fn(async () => {});
    const fetch = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
    );
    const tool = createImageGenTool({
      cwd: workspace,
      homeDir: root,
      confirmOutside,
      fetch,
      getConfig: () => ({
        config: {
          providerId: 'p',
          modelId: 'm',
          protocol: 'openai',
          baseUrl: 'http://localhost/v1',
          apiKey: 'secret',
        },
      }),
    });
    const run = (referenceImages: string[]) =>
      tool.execute('id', { prompt: 'x', referenceImages } as never, undefined, undefined, {
        sessionManager: { getSessionId: () => 's' },
      } as never);
    const first = await run(['ref.png']);
    const output = JSON.parse((first.content[0] as { text: string }).text).items[0].path;
    const second = await run([output]);
    expect(second.isError).toBeFalsy();
    expect(confirmOutside).not.toHaveBeenCalled();
    expect(fetch.mock.calls[0][0]).toContain('/images/edits');
    expect((fetch.mock.calls[0][1].body as FormData).getAll('image[]')).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('不接受路径穿越 session ID 或无效图片字节', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-gen-'));
  try {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] })
        )
    );
    const tool = createImageGenTool({
      cwd: root,
      homeDir: root,
      confirmOutside: async () => {},
      fetch,
      getConfig: () => ({
        config: {
          providerId: 'p',
          modelId: 'm',
          protocol: 'openai',
          baseUrl: 'http://localhost/v1',
          apiKey: 'secret',
        },
      }),
    });
    const run = (session: string) =>
      tool.execute('id', { prompt: 'x' } as never, undefined, undefined, {
        sessionManager: { getSessionId: () => session },
      } as never);
    expect((await run('../outside')).isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect((await run('valid')).isError).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('正常大小的多 MiB 图片可以解码并保存，不能因正则栈溢出失败', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-gen-large-'));
  try {
    const png = Buffer.alloc(8 * 1024 * 1024);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
    );
    const tool = createImageGenTool({
      cwd: root,
      homeDir: root,
      confirmOutside: async () => {},
      fetch,
      getConfig: () => ({
        config: {
          providerId: 'p',
          modelId: 'm',
          protocol: 'openai',
          baseUrl: 'http://localhost/v1',
          apiKey: 'secret',
        },
      }),
    });
    const result = await tool.execute('id', { prompt: 'x' } as never, undefined, undefined, {
      sessionManager: { getSessionId: () => 's' },
    } as never);
    const item = JSON.parse((result.content[0] as { text: string }).text).items[0];
    expect(item.status).toBe('success');
    expect(readFileSync(item.path).equals(png)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('无参考图的远程会话无需本机存在远端 cwd', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-gen-remote-'));
  try {
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
    );
    const tool = createImageGenTool({
      cwd: join(root, 'not-a-local-workspace'),
      homeDir: root,
      confirmOutside: async () => {},
      fetch,
      getConfig: () => ({
        config: {
          providerId: 'p',
          modelId: 'm',
          protocol: 'openai',
          baseUrl: 'http://localhost/v1',
          apiKey: 'secret',
        },
      }),
    });
    const result = await tool.execute('id', { prompt: 'x' } as never, undefined, undefined, {
      sessionManager: { getSessionId: () => 's' },
    } as never);
    expect(result.isError).toBeFalsy();
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
