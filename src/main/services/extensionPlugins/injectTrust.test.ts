import type { PluginInjectSender } from '@shared/extensionPlugins/protocol';
import { describe, expect, it } from 'vitest';
import {
  isBoundOwner,
  type OwnerBindings,
  resolveInjectTrust,
  resolvePluginInjectDelivery,
} from './injectTrust';

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

const bindings = (patch: Partial<OwnerBindings> = {}): OwnerBindings => ({
  telegramOwnerIds: new Set(['1']),
  telegramPrivateChatIds: new Set(['1']),
  channelOwnerIds: new Map([['wechat', new Set(['wx-me'])]]),
  ...patch,
});

const delivery = (
  patch: Partial<Parameters<typeof resolvePluginInjectDelivery>[0]> & {
    sender?: PluginInjectSender;
  } = {}
) =>
  resolvePluginInjectDelivery({
    pluginId: 'enso.tgclient',
    text: '外部原文 token: abcdefgh',
    requestedTrusted: true,
    permissions: ['agent.inject', 'agent.injectTrusted'],
    isSecretarySession: false,
    ownerBindings: bindings(),
    redact: (text) => text.replaceAll('abcdefgh', '[REDACTED]'),
    ...patch,
  });

describe('isBoundOwner', () => {
  it('Telegram 有 userId 时只认主人 id，不因私聊或群 chatId 放行', () => {
    expect(isBoundOwner(undefined, bindings())).toBe(false);
    expect(isBoundOwner({ channel: 'Telegram', userId: '1', chatId: '-100' }, bindings())).toBe(
      true
    );
    expect(isBoundOwner({ channel: 'tg', userId: '9', chatId: '1' }, bindings())).toBe(false);
    expect(isBoundOwner({ channel: 'telegram', chatId: '1' }, bindings())).toBe(true);
    expect(isBoundOwner({ channel: 'telegram', chatId: '-100' }, bindings())).toBe(false);
  });

  it('其他渠道按小写 channel 认已连接的 owner，userId 优先于 chatId', () => {
    expect(isBoundOwner({ channel: 'WeChat', userId: 'wx-me' }, bindings())).toBe(true);
    expect(
      isBoundOwner({ channel: 'wechat', userId: 'wx-other', chatId: 'wx-me' }, bindings())
    ).toBe(false);
    expect(isBoundOwner({ channel: 'wechat', chatId: 'wx-me' }, bindings())).toBe(true);
  });
});

describe('resolvePluginInjectDelivery', () => {
  it('插件自报 owner 无效：userId 对不上仍是外部原文，trusted 也免不了包裹', () => {
    const sender = {
      channel: 'telegram',
      userId: '9',
      isOwner: true,
      role: 'owner',
    } as PluginInjectSender;
    const decision = delivery({ sender });
    expect(decision.origin).toBe('external');
    expect(decision.unwrapped).toBe(false);
    expect(decision.trustedOverriddenByExternal).toBe(true);
    expect(decision.senderIsOwner).toBe(false);
    expect(decision.text).toContain('role="external"');
    expect(decision.text).toContain('sender-id="9"');
    expect(decision.text).not.toContain('isOwner');
  });

  it('宿主核验为 owner 本人：普通会话且插件可信则免包，否则仍包但来源是 owner', () => {
    const sender = { channel: 'telegram', userId: '1', displayName: 'Ada' };
    expect(delivery({ sender })).toMatchObject({
      text: '外部原文 token: abcdefgh',
      origin: 'owner',
      unwrapped: true,
      senderIsOwner: true,
      trustedOverriddenByExternal: false,
    });
    const untrusted = delivery({
      sender,
      requestedTrusted: false,
      permissions: ['agent.inject'],
    });
    expect(untrusted.origin).toBe('owner');
    expect(untrusted.unwrapped).toBe(false);
    expect(untrusted.text).toContain('role="owner"');
  });

  it('没有发送者的旧插件按可信资格决定来源；scheduler 过渡白名单在普通会话免包', () => {
    expect(
      delivery({
        pluginId: 'enso.github',
        requestedTrusted: false,
        permissions: ['agent.inject'],
        sender: undefined,
      })
    ).toMatchObject({ origin: 'external', unwrapped: false });
    expect(
      delivery({
        pluginId: 'enso.scheduler',
        text: '跑一遍测试',
        requestedTrusted: false,
        permissions: ['agent.inject'],
        source: { kind: 'market', id: 'enso.scheduler' },
        sender: undefined,
      })
    ).toEqual({
      text: '跑一遍测试',
      origin: 'owner',
      unwrapped: true,
      trustedIgnored: false,
      trustedOverriddenByExternal: false,
      senderIsOwner: false,
    });
  });

  it('秘书会话一律脱敏并包裹，owner 与 trusted 都不免包', () => {
    const decision = delivery({
      isSecretarySession: true,
      sender: { channel: 'telegram', userId: '1' },
    });
    expect(decision.unwrapped).toBe(false);
    expect(decision.origin).toBe('owner');
    expect(decision.text).toContain('[REDACTED]');
    expect(decision.text).not.toContain('abcdefgh');
    expect(decision.text.startsWith('<untrusted-content ')).toBe(true);
  });
});
