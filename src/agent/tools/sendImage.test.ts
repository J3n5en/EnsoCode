import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DelegationOp } from './delegation';
import type { MemoryInvoker } from './memory';
import { createSendImageTool, normalizeSendImageParams } from './sendImage';

const CWD = '/work/repo';
const sent = (n: number) => ({
  type: 'message',
  message: {
    role: 'toolResult',
    toolName: 'send_image',
    content: [
      {
        type: 'text',
        text: JSON.stringify({ ok: true, mediaId: `${String(n).repeat(64)}.png`, source: 'web' }),
      },
    ],
  },
});
const user = {
  type: 'message',
  message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
};

function setup(branch: unknown[], cwd = CWD) {
  const invoke = vi.fn(async (_op: DelegationOp, params: unknown) => ({
    ok: true,
    mediaId: `${'f'.repeat(64)}.png`,
    source: (params as { path?: string }).path ? 'file' : 'web',
  }));
  const confirm = vi.fn(async (_file: string, _signal?: AbortSignal, _id?: string) => {});
  const tool = createSendImageTool(
    { invoke } as unknown as MemoryInvoker<DelegationOp>,
    cwd,
    confirm
  );
  const ctx = { sessionManager: { getBranch: () => branch } };
  const run = (params: unknown) =>
    tool.execute('call', params as any, undefined, undefined, ctx as any);
  return { tool, invoke, confirm, run };
}

describe('normalizeSendImageParams', () => {
  it('maps aliases, screenshot shorthands and in-workspace absolute paths before validation', () => {
    expect(
      normalizeSendImageParams({ file_path: `${CWD}/docs/a.png`, text: ' 设置页 ' }, CWD)
    ).toEqual({
      path: 'docs/a.png',
      caption: '设置页',
    });
    expect(normalizeSendImageParams({ screenshot: true, caption: null }, CWD)).toEqual({
      screenshot: 1,
    });
    expect(normalizeSendImageParams({ screenshot: 'latest' }, CWD)).toEqual({ screenshot: 1 });
    expect(normalizeSendImageParams({ screenshot: ' 2 ' }, CWD)).toEqual({ screenshot: 2 });
    expect(normalizeSendImageParams({ image: '/etc/x.png', screenshot: false }, CWD)).toEqual({
      path: '/etc/x.png',
    });
    expect(normalizeSendImageParams({ path: '  ', screenshot: 'nope' }, CWD)).toEqual({
      screenshot: 'nope',
    });
    expect(normalizeSendImageParams('bad', CWD)).toBe('bad');
  });

  it('expands ~ and resolves relative paths that leave the workspace to absolute ones', () => {
    expect(normalizeSendImageParams({ path: '~/Desktop/a.png' }, CWD)).toEqual({
      path: join(homedir(), 'Desktop/a.png'),
    });
    expect(normalizeSendImageParams({ path: '../other/a.png' }, CWD)).toEqual({
      path: '/work/other/a.png',
    });
    expect(normalizeSendImageParams({ path: './docs/../a.png' }, CWD)).toEqual({ path: 'a.png' });
  });
});

it('declares a fully typed schema with prepareArguments', () => {
  const { tool } = setup([]);
  expect(tool.name).toBe('send_image');
  const schema = tool.parameters as unknown as {
    type: string;
    required: string[];
    additionalProperties: boolean;
    properties: Record<string, { type?: string; minimum?: number; maximum?: number }>;
  };
  expect(schema.type).toBe('object');
  expect(schema.additionalProperties).toBe(false);
  expect(Object.keys(schema.properties).sort()).toEqual(['caption', 'path', 'screenshot']);
  expect(schema.properties.screenshot).toMatchObject({ type: 'integer', minimum: 1, maximum: 3 });
  for (const property of Object.values(schema.properties)) expect(property).toHaveProperty('type');
  expect(tool.prepareArguments).toBeDefined();
});

describe('execute', () => {
  it('invokes Main with normalized params and returns the JSON result', async () => {
    const { invoke, run } = setup([user]);
    const result = await run({ file: `${CWD}/a.png` });
    expect(invoke).toHaveBeenCalledWith('send_image', { path: 'a.png' }, undefined);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ ok: true });
  });

  it('requires exactly one of path or screenshot', async () => {
    const { invoke, run } = setup([user]);
    expect((await run({})).isError).toBe(true);
    expect((await run({ path: 'a.png', screenshot: 1 })).isError).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('refuses a fifth image in the same reply but counts only since the last user message', async () => {
    const full = setup([sent(1), user, sent(2), sent(3), sent(4), sent(5)]);
    const refused = await full.run({ screenshot: 1 });
    expect(refused.isError).toBe(true);
    expect(full.invoke).not.toHaveBeenCalled();
    const room = setup([sent(1), sent(2), user, sent(3), sent(4), sent(5)]);
    expect((await room.run({ screenshot: 1 })).isError).toBeFalsy();
    expect(room.invoke).toHaveBeenCalledTimes(1);
  });

  it('marks Main failures as errors', async () => {
    const { invoke, run } = setup([user]);
    invoke.mockResolvedValueOnce({ ok: false, error: 'quota', source: 'web' } as never);
    expect((await run({ screenshot: 1 })).isError).toBe(true);
    invoke.mockRejectedValueOnce(new Error('boom'));
    expect((await run({ screenshot: 1 })).isError).toBe(true);
  });

  it('asks for approval before sending a file outside the workspace', async () => {
    const { invoke, confirm, run } = setup([user]);
    await run({ path: '/tmp/shot.png' });
    expect(confirm).toHaveBeenCalledWith('/tmp/shot.png', undefined, 'call');
    expect(invoke).toHaveBeenCalledWith('send_image', { path: '/tmp/shot.png' }, undefined);
    confirm.mockClear();
    await run({ path: 'a.png' });
    await run({ screenshot: 1 });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('does not send when approval is denied', async () => {
    const { invoke, confirm, run } = setup([user]);
    confirm.mockRejectedValueOnce(new Error('User denied this operation'));
    const result = await run({ path: '/tmp/shot.png' });
    expect(result.isError).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('treats a workspace symlink pointing outside as an outside file', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'send-image-')));
    try {
      const cwd = join(root, 'ws');
      mkdirSync(cwd);
      writeFileSync(join(root, 'secret.png'), 'x');
      symlinkSync(join(root, 'secret.png'), join(cwd, 'link.png'));
      const { invoke, confirm, run } = setup([user], cwd);
      await run({ path: 'link.png' });
      expect(confirm).toHaveBeenCalledWith(join(root, 'secret.png'), undefined, 'call');
      expect(invoke).toHaveBeenCalledWith(
        'send_image',
        { path: join(root, 'secret.png') },
        undefined
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
