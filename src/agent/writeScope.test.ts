import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import {
  extractEditTargetPath,
  globToRegExp,
  isPathInWriteScope,
  withWriteScope,
} from './writeScope';

describe('extractEditTargetPath', () => {
  it('优先提取现有 replace 参数的非空 path', () => {
    expect(extractEditTargetPath({ path: 'src/x.ts' })).toBe('src/x.ts');
  });

  it('从 Hashline input 的首个非空文件头提取路径', () => {
    expect(extractEditTargetPath({ input: '\n  [src/x.ts#aBcD]  \nPUT 1.=1:\n+x' })).toBe(
      'src/x.ts'
    );
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
      wrapped.execute('id', { path: 'src/x.ts' }, undefined, undefined, {} as never)
    ).rejects.toThrow(/write scope/);
    expect(def.execute).not.toHaveBeenCalled();
  });

  it('范围内路径透传并返回内部结果', async () => {
    const def = makeToolDef();
    const wrapped = withWriteScope(def, '/repo', ['**/*.test.ts']);
    const result = await wrapped.execute(
      'id',
      { path: 'src/x.test.ts' },
      undefined,
      undefined,
      {} as never
    );
    expect(def.execute).toHaveBeenCalled();
    expect((result.content[0] as { text: string }).text).toBe('ok');
  });

  it('Hashline 文件头路径越界时拒绝且不调用内部 execute', async () => {
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

  it('Hashline 文件头路径在范围内时调用内部 execute', async () => {
    const def = makeToolDef();
    const wrapped = withWriteScope(def, '/repo', ['**/*.test.ts']);
    await wrapped.execute(
      'id',
      { input: '[src/x.test.ts#ABCD]\nPUT 1.=1:\n+x' },
      undefined,
      undefined,
      {} as never
    );
    expect(def.execute).toHaveBeenCalledOnce();
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
