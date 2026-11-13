import { describe, expect, it } from 'vitest';
import { BuiltinToolScopes, sessionDisabledTools } from './builtinToolScopes';

const identity = (sessionId: string) => ({ sessionId, generation: `g-${sessionId}` });

describe('sessionDisabledTools', () => {
  it('项目覆盖优先，叠加会话固定禁用；平台不支持时禁用 computer', () => {
    const state = {
      disabledBuiltinTools: ['web'],
      projects: [{ id: 'p1', disabledBuiltinTools: ['todo'] }],
    };
    expect(sessionDisabledTools(state, 'p1', ['plan'], true)).toEqual(['todo', 'plan']);
    expect(sessionDisabledTools(state, undefined, [], false)).toEqual(['web', 'computer']);
    expect(sessionDisabledTools(undefined, undefined, [], true)).toEqual(['memory', 'computer']);
  });
});

describe('BuiltinToolScopes', () => {
  it('设置变化只对结果变了的会话产出推送，固定禁用始终保留', () => {
    const scopes = new BuiltinToolScopes();
    const state = { disabledBuiltinTools: ['memory'], projects: [{ id: 'p1' }] };
    scopes.remember(identity('a'), 'p1', [], sessionDisabledTools(state, 'p1', [], true));
    scopes.remember(
      identity('b'),
      undefined,
      ['plan'],
      sessionDisabledTools(state, undefined, ['plan'], true)
    );
    expect(scopes.changes(state, true)).toEqual([]);

    const next = {
      disabledBuiltinTools: [],
      projects: [{ id: 'p1', disabledBuiltinTools: ['memory'] }],
    };
    expect(scopes.changes(next, true)).toEqual([
      { identity: identity('b'), disabledTools: ['plan'] },
    ]);
    expect(scopes.changes(next, true)).toEqual([]);

    scopes.forget('b');
    expect(scopes.changes({ disabledBuiltinTools: ['web'], projects: [] }, true)).toEqual([
      { identity: identity('a'), disabledTools: ['web'] },
    ]);
  });

  it('重新 spawn 以新代际覆盖旧作用域', () => {
    const scopes = new BuiltinToolScopes();
    scopes.remember(identity('a'), undefined, [], ['memory']);
    const renewed = { sessionId: 'a', generation: 'g2' };
    scopes.remember(renewed, undefined, [], ['memory']);
    expect(scopes.changes({ disabledBuiltinTools: [] }, true)).toEqual([
      { identity: renewed, disabledTools: [] },
    ]);
  });
});

describe('BuiltinToolScopes：固定开启的开关', () => {
  it('设置变化重算后仍然去掉，不推回给会话', () => {
    const scopes = new BuiltinToolScopes();
    const state = { disabledBuiltinTools: ['memory'] };
    scopes.remember(
      identity('s'),
      undefined,
      [],
      sessionDisabledTools(state, undefined, [], true),
      ['memory']
    );
    expect(scopes.changes(state, true)).toEqual([]);
    expect(scopes.changes({ disabledBuiltinTools: ['memory', 'web'] }, true)).toEqual([
      { identity: identity('s'), disabledTools: ['web'] },
    ]);
  });
});
