import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  SecretaryAuditEntry,
  SecretaryDispatchFile,
  SecretaryToolDraft,
} from '@shared/types/secretary';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSecretaryTools,
  killSecretaryTool,
  listSecretaryTools,
  readSecretaryTool,
  removeSecretaryTool,
  runSecretaryTool,
  type SecretaryToolPorts,
  secretaryToolDescriptors,
  type ToolRunOutcome,
  writeSecretaryTool,
} from './customTools';

const NOW = 7_000;
const ctx = { secretaryConversationId: 'sec-1' };

const draft: SecretaryToolDraft = {
  name: 'upper-text',
  description: '把文本转成大写',
  runtime: 'node',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  readOnly: true,
  code: 'process.stdout.write("x")',
};

const emptyFile = (): SecretaryDispatchFile => ({
  version: 1,
  dispatched: {},
  named: [],
  proposals: {},
  outbox: [],
});

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'secretary-tools-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('tool files on disk', () => {
  it('writes tool.json and the runtime script, and reads them back', () => {
    writeSecretaryTool(dir, draft);
    expect(existsSync(path.join(dir, draft.name, 'main.mjs'))).toBe(true);
    expect(readFileSync(path.join(dir, draft.name, 'tool.json'), 'utf8')).toContain('upper-text');
    expect(readSecretaryTool(dir, draft.name)).toEqual(draft);
    expect(listSecretaryTools(dir)).toEqual([draft]);
  });

  it('switching runtime drops the stale script', () => {
    writeSecretaryTool(dir, draft);
    writeSecretaryTool(dir, { ...draft, runtime: 'python', code: 'print("x")' });
    expect(existsSync(path.join(dir, draft.name, 'main.mjs'))).toBe(false);
    expect(readSecretaryTool(dir, draft.name)?.runtime).toBe('python');
  });

  it('refuses to read or write outside the tools directory', () => {
    expect(readSecretaryTool(dir, '../escape')).toBeNull();
    expect(() => writeSecretaryTool(dir, { ...draft, name: '../escape' })).toThrow(
      'invalid tool name'
    );
    expect(removeSecretaryTool(dir, '../escape')).toBe(false);
  });

  it('skips a broken tool instead of failing the whole list', () => {
    writeSecretaryTool(dir, draft);
    writeSecretaryTool(dir, { ...draft, name: 'second' });
    rmSync(path.join(dir, 'second', 'main.mjs'), { force: true });
    expect(listSecretaryTools(dir).map((tool) => tool.name)).toEqual(['upper-text']);
    expect(secretaryToolDescriptors(dir).map((tool) => tool.name)).toEqual(['my_upper_text']);
  });

  it('以目录名为准：tool.json 里的 name 与目录不一致时按坏工具跳过', () => {
    writeSecretaryTool(dir, draft);
    mkdirSync(path.join(dir, 'renamed'), { recursive: true });
    writeFileSync(
      path.join(dir, 'renamed', 'tool.json'),
      JSON.stringify({ ...draft, name: 'other-name', code: undefined })
    );
    writeFileSync(path.join(dir, 'renamed', 'main.mjs'), draft.code);
    expect(readSecretaryTool(dir, 'renamed')).toBeNull();
    expect(listSecretaryTools(dir).map((tool) => tool.name)).toEqual(['upper-text']);
    expect(secretaryToolDescriptors(dir).map((tool) => tool.name)).toEqual(['my_upper_text']);
  });

  it('removes the directory and reports whether it existed', () => {
    writeSecretaryTool(dir, draft);
    expect(removeSecretaryTool(dir, draft.name)).toBe(true);
    expect(removeSecretaryTool(dir, draft.name)).toBe(false);
    expect(listSecretaryTools(dir)).toEqual([]);
  });
});

describe('killSecretaryTool', () => {
  it('win32 用 taskkill 连子进程一起杀，不动进程组', () => {
    const calls: { file: string; args: string[] }[] = [];
    const fallback = vi.fn();
    killSecretaryTool(42, 'win32', fallback, (file, args) => calls.push({ file, args }));
    expect(calls).toEqual([{ file: 'taskkill', args: ['/pid', '42', '/T', '/F'] }]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('其它平台杀整个进程组，进程组已不在时退回单个进程', () => {
    const fallback = vi.fn();
    const signals: number[] = [];
    killSecretaryTool(
      42,
      'linux',
      fallback,
      () => {},
      (pid) => signals.push(pid)
    );
    expect(signals).toEqual([-42]);
    expect(fallback).not.toHaveBeenCalled();
    killSecretaryTool(
      42,
      'linux',
      fallback,
      () => {},
      () => {
        throw new Error('ESRCH');
      }
    );
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});

describe('runSecretaryTool', () => {
  const nodeTool = (code: string, over: Partial<SecretaryToolDraft> = {}): SecretaryToolDraft => ({
    ...draft,
    code,
    ...over,
  });

  it('feeds the arguments as JSON on stdin and returns stdout', async () => {
    writeSecretaryTool(
      dir,
      nodeTool(
        'let raw = "";process.stdin.on("data", (c) => (raw += c));process.stdin.on("end", () => {const args = JSON.parse(raw);process.stdout.write(args.text.toUpperCase());});'
      )
    );
    const outcome = await runSecretaryTool(dir, readSecretaryTool(dir, draft.name)!, {
      text: 'hello',
    });
    expect(outcome).toEqual({ ok: true, output: 'HELLO' });
  });

  it('reports the stderr tail on a non-zero exit', async () => {
    writeSecretaryTool(dir, nodeTool('process.stderr.write("boom");process.exit(2);'));
    const outcome = await runSecretaryTool(dir, readSecretaryTool(dir, draft.name)!, {});
    expect(outcome).toEqual({ ok: false, error: 'boom' });
  });

  it('kills a tool that runs past its timeout', async () => {
    writeSecretaryTool(dir, nodeTool('setTimeout(() => {}, 60_000);', { timeoutSec: 1 }));
    const started = Date.now();
    const outcome = await runSecretaryTool(dir, readSecretaryTool(dir, draft.name)!, {});
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toContain('超过 1 秒');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('does not leak the parent environment into the tool', async () => {
    process.env.SECRETARY_TOOL_CANARY = 'leaked';
    try {
      writeSecretaryTool(
        dir,
        nodeTool('process.stdout.write(process.env.SECRETARY_TOOL_CANARY ?? "none");')
      );
      const outcome = await runSecretaryTool(dir, readSecretaryTool(dir, draft.name)!, {});
      expect(outcome).toEqual({ ok: true, output: 'none' });
    } finally {
      delete process.env.SECRETARY_TOOL_CANARY;
    }
  });

  it('says python3 is required when it is missing', async () => {
    writeSecretaryTool(dir, { ...draft, runtime: 'python', code: 'print("x")' });
    const outcome = await runSecretaryTool(
      dir,
      readSecretaryTool(dir, draft.name)!,
      {},
      { pythonPath: path.join(dir, 'no-such-python3') }
    );
    expect(!outcome.ok && outcome.error).toContain('python3');
  });
});

interface Harness {
  ports: SecretaryToolPorts;
  service: ReturnType<typeof createSecretaryTools>;
  file: SecretaryDispatchFile;
  audits: SecretaryAuditEntry[];
  released: number;
  notified: number;
  ran: { draft: SecretaryToolDraft; args: unknown }[];
  outcome: ToolRunOutcome;
}

function harness(): Harness {
  let ids = 0;
  const h: Harness = {
    file: emptyFile(),
    audits: [],
    released: 0,
    notified: 0,
    ran: [],
    outcome: { ok: true, output: 'done' },
    ports: undefined as unknown as SecretaryToolPorts,
    service: undefined as unknown as ReturnType<typeof createSecretaryTools>,
  };
  h.ports = {
    dir: () => dir,
    dispatchFile: () => structuredClone(h.file),
    saveDispatch: (file) => {
      h.file = structuredClone(file);
    },
    audit: (entry) => {
      h.audits.push(entry);
    },
    notify: () => {
      h.notified += 1;
    },
    releaseSessions: async () => {
      h.released += 1;
    },
    runTool: async (tool, args) => {
      h.ran.push({ draft: tool, args });
      return h.outcome;
    },
    now: () => NOW,
    newId: () => `id-${++ids}`,
  };
  h.service = createSecretaryTools(h.ports);
  return h;
}

describe('tool_propose', () => {
  it('只出提案，不写盘', async () => {
    const h = harness();
    expect(await h.service.propose({ ...draft }, ctx)).toEqual({
      ok: true,
      result: { status: 'awaiting_confirmation', proposalId: 'id-1' },
    });
    expect(listSecretaryTools(dir)).toEqual([]);
    expect(h.file.proposals['id-1']).toMatchObject({
      kind: 'tool',
      status: 'pending',
      secretaryConversationId: 'sec-1',
      draft,
    });
    expect(h.file.proposals['id-1'].kind === 'tool' && h.file.proposals['id-1'].previous).toBe(
      undefined
    );
    expect(h.audits[0]).toMatchObject({ op: 'secretary_tool_propose', ok: true });
  });

  it('同名工具已存在时带上旧草案', async () => {
    writeSecretaryTool(dir, { ...draft, description: '旧描述', code: 'old' });
    const h = harness();
    await h.service.propose({ ...draft }, ctx);
    const proposal = h.file.proposals['id-1'];
    expect(proposal.kind === 'tool' && proposal.previous).toEqual({
      ...draft,
      description: '旧描述',
      code: 'old',
    });
  });

  it('拒绝非法 slug 与越界代码', async () => {
    const h = harness();
    expect(await h.service.propose({ ...draft, name: '../escape' }, ctx)).toEqual({
      ok: false,
      error: 'invalid tool name',
    });
    expect(await h.service.propose({ ...draft, code: '' }, ctx)).toEqual({
      ok: false,
      error: 'invalid tool code',
    });
    expect(h.file.proposals).toEqual({});
  });
});

describe('tool save and delete', () => {
  it('写盘后审计并释放会话', async () => {
    const h = harness();
    expect(await h.service.save(draft, 'sec-1')).toEqual({ ok: true, name: 'upper-text' });
    expect(readSecretaryTool(dir, 'upper-text')).toEqual(draft);
    expect(h.audits[0]).toMatchObject({ op: 'tool_save', ok: true, targetId: 'upper-text' });
    expect(h.released).toBe(1);
    expect(h.notified).toBe(1);
  });

  it('删除后审计并释放会话，不存在时报 not-found', async () => {
    writeSecretaryTool(dir, draft);
    const h = harness();
    expect(await h.service.remove({ name: 'upper-text' }, null)).toEqual({
      ok: true,
      name: 'upper-text',
    });
    expect(listSecretaryTools(dir)).toEqual([]);
    expect(h.audits[0]).toMatchObject({ op: 'tool_delete', ok: true, targetId: 'upper-text' });
    expect(h.released).toBe(1);
    expect(await h.service.remove({ name: 'upper-text' }, null)).toEqual({
      ok: false,
      error: 'not-found',
    });
    expect(await h.service.remove({ name: '../escape' }, null)).toEqual({
      ok: false,
      error: 'invalid request',
    });
  });
});

describe('tool_run', () => {
  it('按名字读盘执行，结果包成不可信内容', async () => {
    writeSecretaryTool(dir, draft);
    const h = harness();
    h.outcome = { ok: true, output: 'HELLO' };
    const result = await h.service.run(
      {
        name: 'upper-text',
        arguments: { text: 'hello' },
        code: 'worker 传来的代码',
        readOnly: true,
      },
      ctx
    );
    expect(h.ran).toEqual([{ draft, args: { text: 'hello' } }]);
    expect(result.ok && result.result).toEqual({
      output: '<untrusted-content source="tool:upper-text">HELLO</untrusted-content>',
    });
  });

  it('描述符与盘上版本不一致时拒绝执行，不用新代码跑旧会话', async () => {
    writeSecretaryTool(dir, { ...draft, readOnly: false });
    const h = harness();
    expect(await h.service.run({ name: 'upper-text', arguments: {}, readOnly: true }, ctx)).toEqual(
      {
        ok: false,
        error: '工具已更新，请在新会话中重试',
      }
    );
    expect(h.ran).toEqual([]);
    expect(await h.service.run({ name: 'upper-text', arguments: {} }, ctx)).toEqual({
      ok: false,
      error: 'invalid arguments',
    });
    expect(
      await h.service.run({ name: 'upper-text', arguments: {}, readOnly: false }, ctx)
    ).toMatchObject({ ok: true });
  });

  it('非只读工具每次执行留一条审计，只读的不记', async () => {
    writeSecretaryTool(dir, { ...draft, readOnly: false });
    const h = harness();
    h.outcome = { ok: true, output: 'done' };
    await h.service.run(
      { name: 'upper-text', arguments: { text: 'ARGVALUE' }, readOnly: false },
      ctx
    );
    h.outcome = { ok: false, error: 'boom' };
    await h.service.run({ name: 'upper-text', arguments: {}, readOnly: false }, ctx);
    expect(h.audits).toEqual([
      {
        at: NOW,
        secretaryConversationId: 'sec-1',
        op: 'tool_run',
        targetId: 'upper-text',
        ok: true,
        detail: 'succeeded',
      },
      {
        at: NOW,
        secretaryConversationId: 'sec-1',
        op: 'tool_run',
        targetId: 'upper-text',
        ok: false,
        detail: 'boom',
      },
    ]);
    expect(JSON.stringify(h.audits)).not.toContain('ARGVALUE');

    writeSecretaryTool(dir, draft);
    h.audits.length = 0;
    await h.service.run({ name: 'upper-text', arguments: {}, readOnly: true }, ctx);
    expect(h.audits).toEqual([]);
  });

  it('输出里的密钥先脱敏', async () => {
    writeSecretaryTool(dir, draft);
    const h = harness();
    h.outcome = { ok: true, output: 'key AKIAABCDEFGHIJKLMNOP' };
    const result = await h.service.run({ name: 'upper-text', arguments: {}, readOnly: true }, ctx);
    expect(result.ok && String((result.result as { output: string }).output)).not.toContain(
      'AKIAABCDEFGHIJKLMNOP'
    );
  });

  it('失败带不可信的 stderr，未知名字直接拒绝', async () => {
    writeSecretaryTool(dir, draft);
    const h = harness();
    h.outcome = { ok: false, error: 'boom' };
    const failed = await h.service.run({ name: 'upper-text', arguments: {}, readOnly: true }, ctx);
    expect(failed).toEqual({
      ok: false,
      error: '<untrusted-content source="tool:upper-text">boom</untrusted-content>',
    });
    expect(
      await h.service.run({ name: 'no-such-tool', arguments: {}, readOnly: true }, ctx)
    ).toEqual({
      ok: false,
      error: 'not-found',
    });
    expect(await h.service.run({ name: '../escape', arguments: {}, readOnly: true }, ctx)).toEqual({
      ok: false,
      error: 'invalid arguments',
    });
    expect(await h.service.run({ name: 'upper-text', arguments: [], readOnly: true }, ctx)).toEqual(
      {
        ok: false,
        error: 'invalid arguments',
      }
    );
  });
});
