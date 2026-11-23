import { describe, expect, it } from 'vitest';
import { resolveInjectTrust } from './injectTrust';

const market = (id: string) => ({ kind: 'market' as const, id });

describe('resolveInjectTrust', () => {
  it('声明了 agent.injectTrusted 的插件，带 trusted 才免包裹', () => {
    const permissions = ['agent.inject', 'agent.injectTrusted'] as const;
    expect(
      resolveInjectTrust({ pluginId: 'a.b', requested: true, permissions: [...permissions] })
    ).toEqual({ trusted: true, ignored: false });
    expect(
      resolveInjectTrust({ pluginId: 'a.b', requested: false, permissions: [...permissions] })
    ).toEqual({ trusted: false, ignored: false });
  });

  it('没有这项权限的插件带了 trusted：忽略并要求记日志', () => {
    expect(
      resolveInjectTrust({ pluginId: 'a.b', requested: true, permissions: ['agent.inject'] })
    ).toEqual({ trusted: false, ignored: true });
  });

  it('过渡白名单：从市场装的旧版 scheduler / kanban / bridge 不带参数也视为可信', () => {
    for (const pluginId of ['enso.scheduler', 'enso.kanban', 'enso.bridge']) {
      expect(
        resolveInjectTrust({
          pluginId,
          requested: false,
          permissions: ['agent.inject'],
          source: market(pluginId),
        })
      ).toEqual({ trusted: true, ignored: false });
    }
  });

  it('白名单不认本地装的同名插件，也不覆盖其他官方插件', () => {
    expect(
      resolveInjectTrust({
        pluginId: 'enso.scheduler',
        requested: true,
        permissions: ['agent.inject'],
        source: { kind: 'dir', path: '/tmp/x' },
      })
    ).toEqual({ trusted: false, ignored: true });
    expect(
      resolveInjectTrust({
        pluginId: 'enso.github',
        requested: false,
        permissions: ['agent.inject'],
        source: market('enso.github'),
      }).trusted
    ).toBe(false);
  });

  it('插件升级到声明了这项权限的版本后，白名单不再兜底，按 trusted 参数走', () => {
    expect(
      resolveInjectTrust({
        pluginId: 'enso.bridge',
        requested: false,
        permissions: ['agent.inject', 'agent.injectTrusted'],
        source: market('enso.bridge'),
      }).trusted
    ).toBe(false);
  });
});
