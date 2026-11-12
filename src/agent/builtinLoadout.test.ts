import { describe, expect, it } from 'vitest';
import { enabledHotBuiltins, nextActiveToolNames } from './builtinLoadout';

describe('enabledHotBuiltins', () => {
  it('ImageGen 可热切，禁用后不进入激活工具列表', () => {
    expect(enabledHotBuiltins([]).has('image_generation')).toBe(true);
    const groups = new Map([['image_generation', ['ImageGen']]]);
    expect(
      nextActiveToolNames(['read', 'ImageGen'], groups, enabledHotBuiltins(['image_generation']))
    ).toEqual(['read']);
    expect(nextActiveToolNames(['read'], groups, enabledHotBuiltins([]))).toEqual([
      'read',
      'ImageGen',
    ]);
  });

  it('turn_discard 默认开启，可在会话中途关掉', () => {
    expect(enabledHotBuiltins([]).has('turn_discard')).toBe(true);
    expect(enabledHotBuiltins(['turn_discard']).has('turn_discard')).toBe(false);
  });

  it('workflow 依赖 subagent；spawn 时定型的工具不在热切范围', () => {
    const enabled = enabledHotBuiltins(['subagent', 'isolated_sandbox']);
    expect(enabled.has('workflow')).toBe(false);
    expect(enabled.has('subagent')).toBe(false);
    expect(enabled.has('todo')).toBe(true);
    expect(enabled.has('isolated_sandbox')).toBe(false);
  });
});

describe('nextActiveToolNames', () => {
  const groups = new Map([
    ['todo', ['todo']],
    ['browser', ['browser_open', 'browser_click']],
    ['memory', ['memory_search']],
  ]);

  it('关掉的组移出，打开的组追加在末尾，其它工具（MCP、codemode）原序保留', () => {
    const next = nextActiveToolNames(
      ['read', 'todo', 'browser_open', 'browser_click', 'mcp__x', 'codemode'],
      groups,
      new Set(['todo', 'memory'])
    );
    expect(next).toEqual(['read', 'todo', 'mcp__x', 'codemode', 'memory_search']);
  });

  it('已经是目标状态时原样返回', () => {
    const active = ['read', 'todo', 'memory_search'];
    expect(nextActiveToolNames(active, groups, new Set(['todo', 'memory']))).toEqual(active);
  });
});
