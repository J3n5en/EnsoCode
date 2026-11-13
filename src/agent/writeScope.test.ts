import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWriteToolDefinition, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { createApplyPatchTool, validateApplyPatchTargets } from './applyPatch';
import { ApprovalGate, withApproval } from './approval';
import { createNormalizedEditTool } from './editTool';
import {
  extractEditTargetPath,
  extractWriteTargetPaths,
  globToRegExp,
  isPathInWriteScope,
  withWritePreflight,
  withWriteScope,
} from './writeScope';

describe('extractEditTargetPath', () => {
  it('提取现有 replace 参数的非空 path', () => {
    expect(extractEditTargetPath({ path: 'src/x.ts', edits: [] })).toBe('src/x.ts');
  });
});

describe('extractWriteTargetPaths', () => {
  it('apply_patch 优先走自身 parser，返回全部目标并包含 move 两端', () => {
    const input = [
      '*** Begin Patch',
      '*** Update File: src/old.test.ts',
      '*** Move to: src/new.test.ts',
      '@@',
      ' keep',
      '*** End Patch',
    ].join('\n');
    expect(extractWriteTargetPaths('apply_patch', { input })).toEqual([
      'src/old.test.ts',
      'src/new.test.ts',
    ]);
    expect(() =>
      extractWriteTargetPaths('apply_patch', { input, path: 'src/decoy.test.ts' })
    ).toThrow(/exactly one/);
  });

  it('非 apply_patch 不会把普通 input 与 patch parser 串台，也不退回诱饵 path', () => {
    expect(
      extractWriteTargetPaths('edit', {
        input: '*** Begin Patch\n*** Add File: src/a.test.ts\n+x\n*** End Patch',
        path: 'src/decoy.test.ts',
      })
    ).toEqual([]);
  });
});

describe('globToRegExp', () => {
  it('**/*.test.ts 命中嵌套路径 a/b/c.test.ts', () => {
    expect(globToRegExp('**/*.test.ts').test('a/b/c.test.ts')).toBe(true);
  });

  it('**/*.test.ts 命中零层级路径 c.test.ts', () => {
    expect(globToRegExp('**/*.test.ts').test('c.test.ts')).toBe(true);
  });

  it('**/*.test.ts 不命中非测试文件 c.ts', () => {
    expect(globToRegExp('**/*.test.ts').test('c.ts')).toBe(false);
  });

  it('**/*.test.ts 不命中扩展名不同的 c.test.tsx', () => {
    expect(globToRegExp('**/*.test.ts').test('c.test.tsx')).toBe(false);
  });

  it('test/** 命中任意深度的 test/x/y.ts', () => {
    expect(globToRegExp('test/**').test('test/x/y.ts')).toBe(true);
  });
});

describe('isPathInWriteScope', () => {
  const cwd = '/repo';
  const scope = ['**/*.test.ts'];

  it('绝对路径解析到 cwd 下命中', () => {
    expect(isPathInWriteScope('/repo/src/a.test.ts', cwd, scope)).toBe(true);
  });

  it('相对路径命中', () => {
    expect(isPathInWriteScope('src/a.test.ts', cwd, scope)).toBe(true);
  });

  it('../ 逃逸出 cwd 恒为 false', () => {
    expect(isPathInWriteScope('../outside/a.test.ts', cwd, scope)).toBe(false);
  });

  it('Windows 反斜杠路径归一后仍能命中', () => {
    expect(isPathInWriteScope('src\\a.test.ts', cwd, scope)).toBe(true);
  });

  it('绝对路径不在 cwd 下恒为 false', () => {
    expect(isPathInWriteScope('/other/src/a.test.ts', cwd, scope)).toBe(false);
  });

  it('Windows cwd 下盘符绝对路径命中', () => {
    expect(isPathInWriteScope('C:\\repo\\src\\a.test.ts', 'C:\\repo', scope)).toBe(true);
  });

  it('Windows cwd 下其他盘符/cwd 外绝对路径恒为 false', () => {
    expect(isPathInWriteScope('D:\\repo\\src\\a.test.ts', 'C:\\repo', scope)).toBe(false);
    expect(isPathInWriteScope('C:\\outside\\a.test.ts', 'C:\\repo', scope)).toBe(false);
  });
});

describe('withWritePreflight', () => {
  it('完整只读预检失败时不会进入审批层，成功时才继续', async () => {
    const approvalExecute = vi.fn(async () => ({ content: [], details: undefined }));
    const approval = {
      name: 'apply_patch',
      label: 'apply_patch',
      description: '',
      parameters: { type: 'object', properties: {} },
      execute: approvalExecute,
    } as unknown as ToolDefinition;
    const failed = withWritePreflight(approval, async () => {
      throw new Error('preflight conflict');
    });
    await expect(
      failed.execute('patch', { input: 'invalid' }, undefined, undefined, {} as never)
    ).rejects.toThrow('preflight conflict');
    expect(approvalExecute).not.toHaveBeenCalled();

    const controller = new AbortController();
    const seenSignal = vi.fn();
    const passed = withWritePreflight(approval, async (_params, signal) => seenSignal(signal));
    await passed.execute('patch', { input: 'valid' }, controller.signal, undefined, {} as never);
    expect(seenSignal).toHaveBeenCalledWith(controller.signal);
    expect(approvalExecute).toHaveBeenCalledTimes(1);
  });
});

describe('withWriteScope', () => {
  function makeToolDef(): ToolDefinition {
    return {
      name: 'edit',
      label: 'Edit',
      description: 'edit',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      execute: vi.fn(async () => ({
        content: [{ type: 'text' as const, text: 'ok' }],
        details: undefined,
      })),
    } as unknown as ToolDefinition;
  }

  it('越界路径 throw /write scope/ 且不调用内部 execute', async () => {
    const def = makeToolDef();
    const wrapped = withWriteScope(def, '/repo', ['**/*.test.ts']);
    await expect(
      wrapped.execute('id', { path: 'src/x.ts', edits: [] }, undefined, undefined, {} as never)
    ).rejects.toThrow(/write scope/);
    expect(def.execute).not.toHaveBeenCalled();
  });

  it('范围内路径透传并返回内部结果', async () => {
    const def = makeToolDef();
    const wrapped = withWriteScope(def, '/repo', ['**/*.test.ts']);
    const result = await wrapped.execute(
      'id',
      { path: 'src/x.test.ts', edits: [] },
      undefined,
      undefined,
      {} as never
    );
    expect(def.execute).toHaveBeenCalled();
    expect((result.content[0] as { text: string }).text).toBe('ok');
  });

  it('只有 input、没有 path 时拒绝且不调用内部 execute', async () => {
    const def = makeToolDef();
    const wrapped = withWriteScope(def, '/repo', ['**/*.test.ts']);
    await expect(
      wrapped.execute(
        'id',
        { input: '[src/x.ts#ABCD]\nPUT 1.=1:\n+x' },
        undefined,
        undefined,
        {} as never
      )
    ).rejects.toThrow(/write scope/);
    expect(def.execute).not.toHaveBeenCalled();
  });

  it('apply_patch 第二个目标越界时在审批和写入前拒绝，move 两端同样全量检查', async () => {
    const executed = vi.fn(async () => ({ content: [], details: {} }));
    const definition = {
      ...makeToolDef(),
      name: 'apply_patch',
      execute: executed,
    } as unknown as ToolDefinition;
    const requests: string[] = [];
    const gate = new ApprovalGate(
      'assistant',
      (info) => requests.push(info.summary),
      () => undefined,
      { review: async () => ({ decision: 'auto_allow' }) }
    );
    const wrapped = withWriteScope(withApproval(gate, 'file-edit', definition), '/repo', [
      'allowed/**',
    ]);
    const input = [
      '*** Begin Patch',
      '*** Add File: allowed/a.ts',
      '+a',
      '*** Update File: allowed/old.ts',
      '*** Move to: outside/new.ts',
      '@@',
      ' keep',
      '*** End Patch',
    ].join('\n');

    await expect(
      wrapped.execute('patch', { input }, undefined, undefined, {} as never)
    ).rejects.toThrow(/write scope/);
    expect(requests).toEqual([]);
    expect(executed).not.toHaveBeenCalled();
  });

  it('apply_patch 显式外部绝对路径仍被非空 writeScope 在审批前拒绝', async () => {
    const executed = vi.fn(async () => ({ content: [], details: {} }));
    const definition = {
      ...makeToolDef(),
      name: 'apply_patch',
      execute: executed,
    } as unknown as ToolDefinition;
    const requests: string[] = [];
    const gate = new ApprovalGate(
      'supervised',
      (info) => requests.push(info.summary),
      () => {}
    );
    const wrapped = withWriteScope(withApproval(gate, 'file-edit', definition), '/repo', [
      'allowed/**',
    ]);
    const input = ['*** Begin Patch', '*** Add File: /external/a.ts', '+a', '*** End Patch'].join(
      '\n'
    );

    await expect(
      wrapped.execute('patch', { input }, undefined, undefined, {} as never)
    ).rejects.toThrow(/write scope/);
    expect(requests).toEqual([]);
    expect(executed).not.toHaveBeenCalled();
  });

  it('apply_patch 审批摘要保留全部目标与 move 两端，拒绝时零写入', async () => {
    const executed = vi.fn(async () => ({ content: [], details: {} }));
    const definition = {
      ...makeToolDef(),
      name: 'apply_patch',
      execute: executed,
    } as unknown as ToolDefinition;
    const infos: Array<{ requestId: string; summary: string }> = [];
    const gate = new ApprovalGate(
      'supervised',
      (info) => infos.push(info),
      () => undefined
    );
    const wrapped = withWriteScope(withApproval(gate, 'file-edit', definition), '/repo', [
      'allowed/**',
    ]);
    const input = [
      '*** Begin Patch',
      '*** Add File: allowed/a.ts',
      '+a',
      '*** Update File: allowed/old.ts',
      '*** Move to: allowed/new.ts',
      '@@',
      ' keep',
      '*** End Patch',
    ].join('\n');
    const pending = wrapped.execute('patch', { input }, undefined, undefined, {} as never);
    await vi.waitFor(() => expect(infos).toHaveLength(1));
    expect(infos[0].summary).toBe('allowed/a.ts\nallowed/old.ts\nallowed/new.ts');
    gate.respond(infos[0].requestId, 'deny');
    await expect(pending).rejects.toThrow(/denied/);
    expect(executed).not.toHaveBeenCalled();
  });

  it('真实 apply_patch 引擎通过 scope 与审批后写入，摘要列出全部目标', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'enso-patch-scope-'));
    try {
      await mkdir(path.join(cwd, 'allowed'));
      await writeFile(path.join(cwd, 'allowed/a.ts'), 'before\n');
      const requests: string[] = [];
      const gate = new ApprovalGate(
        'assistant',
        (info) => requests.push(info.summary),
        () => undefined,
        { review: async () => ({ decision: 'auto_allow' }) }
      );
      const tool = withWriteScope(
        withWritePreflight(
          withApproval(gate, 'file-edit', createApplyPatchTool({ cwd })),
          (params) => validateApplyPatchTargets(cwd, params)
        ),
        cwd,
        ['allowed/**']
      );
      const input = [
        '*** Begin Patch',
        '*** Update File: allowed/a.ts',
        '@@',
        '-before',
        '+after',
        '*** Add File: allowed/b.ts',
        '+new',
        '*** End Patch',
      ].join('\n');
      await tool.execute('patch', { input }, undefined, undefined, {} as never);
      expect(await readFile(path.join(cwd, 'allowed/a.ts'), 'utf8')).toBe('after\n');
      expect(await readFile(path.join(cwd, 'allowed/b.ts'), 'utf8')).toBe('new\n');
      expect(requests).toEqual(['allowed/a.ts\nallowed/b.ts']);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('真实 apply_patch 无 scope 时按既有审批规则写显式外部绝对路径', async () => {
    const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'enso-patch-approval-cwd-')));
    const outside = await realpath(
      await mkdtemp(path.join(tmpdir(), 'enso-patch-approval-outside-'))
    );
    const target = path.join(outside, 'target.ts');
    try {
      await writeFile(target, 'before\n');
      const requests: string[] = [];
      const gate = new ApprovalGate(
        'assistant',
        (info) => requests.push(info.summary),
        () => {},
        { review: async () => ({ decision: 'auto_allow' }) }
      );
      const tool = withWriteScope(
        withWritePreflight(
          withApproval(gate, 'file-edit', createApplyPatchTool({ cwd })),
          (params) => validateApplyPatchTargets(cwd, params)
        ),
        cwd,
        undefined
      );
      const input = [
        '*** Begin Patch',
        `*** Update File: ${target}`,
        '@@',
        '-before',
        '+after',
        '*** End Patch',
      ].join('\n');

      await tool.execute('patch', { input }, undefined, undefined, {} as never);
      expect(requests).toEqual([target]);
      expect(await readFile(target, 'utf8')).toBe('after\n');
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('真实 write 工具按 path+content 检查范围内透传、越界拒绝', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'enso-write-scope-'));
    try {
      await mkdir(path.join(cwd, 'allowed'));
      const tool = withWriteScope(
        createWriteToolDefinition(cwd) as unknown as ToolDefinition,
        cwd,
        ['allowed/**']
      );
      await tool.execute(
        'allowed-write',
        { path: 'allowed/a.ts', content: 'ok\n' },
        undefined,
        undefined,
        {} as never
      );
      expect(await readFile(path.join(cwd, 'allowed/a.ts'), 'utf8')).toBe('ok\n');

      await expect(
        tool.execute(
          'outside-write',
          { path: 'outside.ts', content: 'blocked\n' },
          undefined,
          undefined,
          {} as never
        )
      ).rejects.toThrow(/write scope/);
      await expect(readFile(path.join(cwd, 'outside.ts'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('真实 normalized edit 保留字符串 edits 归一化并仍检查唯一 path', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'enso-edit-scope-'));
    try {
      await mkdir(path.join(cwd, 'src'));
      await writeFile(path.join(cwd, 'src/allowed.test.ts'), 'before\n');
      await writeFile(path.join(cwd, 'src/outside.ts'), 'outside\n');
      const tool = withWriteScope(createNormalizedEditTool(cwd), cwd, ['**/*.test.ts']);
      const edits = JSON.stringify([{ oldText: 'before', newText: 'after' }]);

      await tool.execute(
        'normalized',
        { path: 'src/allowed.test.ts', edits },
        undefined,
        undefined,
        {} as never
      );
      expect(await readFile(path.join(cwd, 'src/allowed.test.ts'), 'utf8')).toBe('after\n');

      await expect(
        tool.execute(
          'outside',
          {
            path: 'src/outside.ts',
            edits: JSON.stringify([{ oldText: 'outside', newText: 'bad' }]),
          },
          undefined,
          undefined,
          {} as never
        )
      ).rejects.toThrow(/write scope/);
      expect(await readFile(path.join(cwd, 'src/outside.ts'), 'utf8')).toBe('outside\n');

      await expect(
        tool.execute(
          'path-only',
          { path: 'src/allowed.test.ts' },
          undefined,
          undefined,
          {} as never
        )
      ).rejects.toThrow();
      expect(await readFile(path.join(cwd, 'src/allowed.test.ts'), 'utf8')).toBe('after\n');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // 审计实测：pi 的 write 经 resolveToCwd 展开 ~，按字面检查时 ~/notes.md 被当成 cwd 内路径、实际写进 HOME
  it('真实 write 工具的 ~/ 路径按 pi 规则展开到 HOME，越出 cwd 时拒绝且不落盘', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'enso-write-scope-home-'));
    const cwd = path.join(root, 'repo');
    const home = path.join(root, 'home');
    // os.homedir() 读 HOME / USERPROFILE：缺陷存在时也只会写进临时目录
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    try {
      await mkdir(cwd);
      await mkdir(home);
      const tool = withWriteScope(
        createWriteToolDefinition(cwd) as unknown as ToolDefinition,
        cwd,
        ['**/*.md']
      );
      await expect(
        tool.execute(
          'home',
          { path: '~/notes.md', content: 'x\n' },
          undefined,
          undefined,
          {} as never
        )
      ).rejects.toThrow(/write scope/);
      await expect(readFile(path.join(home, 'notes.md'), 'utf8')).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  // 审计实测：pi 的 write 会剥掉前导 @，按字面检查时 @../outside.md 被当成 cwd 内路径、实际写到上级目录
  it('真实 write 工具的 @../ 路径剥掉 @ 后越出 cwd，拒绝且不落盘', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'enso-write-scope-at-'));
    const cwd = path.join(root, 'repo');
    try {
      await mkdir(cwd);
      const tool = withWriteScope(
        createWriteToolDefinition(cwd) as unknown as ToolDefinition,
        cwd,
        ['**/*.md']
      );
      await expect(
        tool.execute(
          'at',
          { path: '@../outside.md', content: 'x\n' },
          undefined,
          undefined,
          {} as never
        )
      ).rejects.toThrow(/write scope/);
      await expect(readFile(path.join(root, 'outside.md'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // 反例：判定与真实落点同源，@ 前缀的范围内路径剥掉 @ 后照常放行
  it('真实 write 工具的 @docs/ 路径按 pi 规则落在范围内时放行并写入', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'enso-write-scope-at-in-'));
    try {
      const tool = withWriteScope(
        createWriteToolDefinition(cwd) as unknown as ToolDefinition,
        cwd,
        ['docs/**']
      );
      await tool.execute(
        'at-in',
        { path: '@docs/a.md', content: 'ok\n' },
        undefined,
        undefined,
        {} as never
      );
      expect(await readFile(path.join(cwd, 'docs/a.md'), 'utf8')).toBe('ok\n');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // 反例：apply_patch 自己按字面解析路径（@docs/a.md 落在 cwd/@docs/a.md），不能套用 pi 的 @/~ 归一
  it('apply_patch 的 @docs/ 路径按字面判定，不当作 docs/ 放行', async () => {
    const executed = vi.fn(async () => ({ content: [], details: {} }));
    const definition = {
      ...makeToolDef(),
      name: 'apply_patch',
      execute: executed,
    } as unknown as ToolDefinition;
    const wrapped = withWriteScope(definition, '/repo', ['docs/**']);
    const input = ['*** Begin Patch', '*** Add File: @docs/a.md', '+a', '*** End Patch'].join('\n');
    await expect(
      wrapped.execute('patch', { input }, undefined, undefined, {} as never)
    ).rejects.toThrow(/write scope/);
    expect(executed).not.toHaveBeenCalled();
  });

  it('scope 为 undefined 时原样返回同一对象', () => {
    const def = makeToolDef();
    expect(withWriteScope(def, '/repo', undefined)).toBe(def);
  });

  it('scope 为空数组时原样返回同一对象', () => {
    const def = makeToolDef();
    expect(withWriteScope(def, '/repo', [])).toBe(def);
  });
});
