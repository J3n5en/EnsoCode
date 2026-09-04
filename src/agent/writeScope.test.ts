import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { globToRegExp, isPathInWriteScope, withWriteScope } from './writeScope';

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

  it('scope 为 undefined 时原样返回同一对象', () => {
    const def = makeToolDef();
    expect(withWriteScope(def, '/repo', undefined)).toBe(def);
  });

  it('scope 为空数组时原样返回同一对象', () => {
    const def = makeToolDef();
    expect(withWriteScope(def, '/repo', [])).toBe(def);
  });
});
