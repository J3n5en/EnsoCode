import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TOOLS,
  DEFAULT_DISABLED_BUILTIN_TOOLS,
  effectiveDisabledBuiltinTools,
  projectDisabledBuiltinTools,
  resolveDisabledBuiltinTools,
} from './builtinTools';

describe('effectiveDisabledBuiltinTools', () => {
  it('缺字段时用默认关闭列表：memory 默认关，其余全开', () => {
    expect(effectiveDisabledBuiltinTools(undefined)).toEqual(['memory']);
    for (const id of DEFAULT_DISABLED_BUILTIN_TOOLS) {
      expect(
        BUILTIN_TOOLS.some((tool) => tool.id === id),
        id
      ).toBe(true);
    }
  });

  it('用户显式存了空列表 = 全开（不重新叠加默认关闭）', () => {
    expect(effectiveDisabledBuiltinTools([])).toEqual([]);
  });

  it('只保留字符串 id，列表原样透传', () => {
    expect(effectiveDisabledBuiltinTools(['browser', 1, 'isolated_sandbox'])).toEqual([
      'browser',
      'isolated_sandbox',
    ]);
  });
});

describe('resolveDisabledBuiltinTools', () => {
  it('缺项目覆盖时用全局列表', () => {
    expect(resolveDisabledBuiltinTools(['browser'])).toEqual(['browser']);
    expect(resolveDisabledBuiltinTools(['browser'], undefined)).toEqual(['browser']);
    expect(resolveDisabledBuiltinTools(['browser'], {})).toEqual(['browser']);
  });

  it('项目存了列表则覆盖全局（空列表 = 本项目全开）', () => {
    expect(
      resolveDisabledBuiltinTools(['browser', 'memory'], { disabledBuiltinTools: ['subagent'] })
    ).toEqual(['subagent']);
    expect(resolveDisabledBuiltinTools(['memory'], { disabledBuiltinTools: [] })).toEqual([]);
  });

  it('项目字段不是数组时仍跟全局，不把脏值当成覆盖', () => {
    expect(resolveDisabledBuiltinTools(['browser'], { disabledBuiltinTools: 'memory' })).toEqual([
      'browser',
    ]);
  });
});

describe('projectDisabledBuiltinTools', () => {
  const projects = [{ id: 'p1', disabledBuiltinTools: ['browser'] }, { id: 'p2' }];

  it('按 id 取出项目覆盖，找不到或未覆盖返回 undefined', () => {
    expect(projectDisabledBuiltinTools(projects, 'p1')).toEqual(['browser']);
    expect(projectDisabledBuiltinTools(projects, 'p2')).toBeUndefined();
    expect(projectDisabledBuiltinTools(projects, 'missing')).toBeUndefined();
    expect(projectDisabledBuiltinTools(projects, undefined)).toBeUndefined();
    expect(projectDisabledBuiltinTools(undefined, 'p1')).toBeUndefined();
  });
});
