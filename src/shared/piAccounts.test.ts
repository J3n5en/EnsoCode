import { describe, expect, it } from 'vitest';
import type { AccountProviderRuntime } from './piAccounts';
import {
  ensureAccountProvider,
  nextAccountKey,
  ordinalOfAccountKey,
  syncAccountProviders,
} from './piAccounts';
import { accountKeyFor, providerIdOfAccountKey } from './types/oauthProviders';

describe('账号 key 的生成与反解', () => {
  it('第一个账号沿用裸 providerId（兼容 pi CLI 与旧版本写入的 auth.json）', () => {
    expect(accountKeyFor('anthropic', 0)).toBe('anthropic');
    expect(nextAccountKey('anthropic', [])).toBe('anthropic');
  });

  it('已有裸 key 时新账号排到 #2', () => {
    expect(nextAccountKey('anthropic', ['anthropic'])).toBe('anthropic#2');
  });

  it('同一份 auth.json 里其他 provider 的账号不参与序号计算', () => {
    expect(nextAccountKey('anthropic', ['openai-codex', 'openai-codex#2', 'xai'])).toBe(
      'anthropic'
    );
  });

  it('key 与序号可来回换算', () => {
    for (const ordinal of [0, 1, 2, 7]) {
      expect(ordinalOfAccountKey(accountKeyFor('anthropic', ordinal))).toBe(ordinal);
    }
  });

  it('反解出的基础 providerId 不受 # 后缀影响', () => {
    expect(providerIdOfAccountKey('anthropic')).toBe('anthropic');
    expect(providerIdOfAccountKey('anthropic#3')).toBe('anthropic');
    // provider id 自带连字符（google-antigravity）时也不能被截断
    expect(providerIdOfAccountKey('google-antigravity#2')).toBe('google-antigravity');
  });

  it('脏 key（#后不是数字）当作裸 key 的序号 0，不返回 NaN', () => {
    expect(ordinalOfAccountKey('anthropic#')).toBe(0);
    expect(ordinalOfAccountKey('anthropic#abc')).toBe(0);
  });
});

describe('登出裸 key 之后的分配', () => {
  // 真实场景：用户有 anthropic 与 anthropic#2 两个账号，登出了第一个（裸 key 那格空了）。
  // 序号必须继续递增而不是回收空位——settings 里的 provider 条目存的就是这个 key，
  // 复用 'anthropic' 会让残留的旧条目静默绑到新账号的凭证上。
  it('裸 key 被登出后不回收，新账号排到 #3', () => {
    expect(nextAccountKey('anthropic', ['anthropic#2'])).toBe('anthropic#3');
  });

  it('中间空位（#2 被登出）同样不回收', () => {
    expect(nextAccountKey('anthropic', ['anthropic', 'anthropic#3'])).toBe('anthropic#4');
  });
});

/** ModelRuntime 的最小替身：只实现 syncAccountProviders 用到的四个方法 */
function fakeRuntime(options: { builtins: string[]; credentials: string[] }): {
  runtime: AccountProviderRuntime;
  registered: () => string[];
  unregistered: string[];
} {
  const providers = new Map<string, { id: string; getModels: () => { provider: string }[] }>();
  for (const id of options.builtins) {
    providers.set(id, { id, getModels: () => [{ provider: id }] });
  }
  const unregistered: string[] = [];
  const runtime = {
    listCredentials: async () =>
      options.credentials.map((providerId) => ({ providerId, type: 'oauth' as const })),
    getProviders: () => [...providers.values()],
    getProvider: (id: string) => providers.get(id),
    registerNativeProvider: (provider: { id: string }) => {
      providers.set(provider.id, provider as never);
    },
    unregisterProvider: (id: string) => {
      unregistered.push(id);
      providers.delete(id);
    },
  };
  return {
    runtime: runtime as unknown as AccountProviderRuntime,
    registered: () => [...providers.keys()],
    unregistered,
  };
}

describe('克隆 provider 的注册表对齐', () => {
  it('auth.json 里的 #n 账号被注册成克隆，裸 key 沿用内置 provider', async () => {
    const fake = fakeRuntime({
      builtins: ['anthropic', 'xai'],
      credentials: ['anthropic', 'anthropic#2', 'xai'],
    });
    await syncAccountProviders(fake.runtime);
    expect(fake.registered()).toEqual(['anthropic', 'xai', 'anthropic#2']);
    expect(fake.unregistered).toEqual([]);
  });

  it('不安全的 Cursor 克隆会被清掉，支持多账号的 provider 仍正常注册', async () => {
    const fake = fakeRuntime({
      builtins: ['anthropic', 'cursor', 'cursor#2'],
      credentials: ['anthropic#2', 'cursor#2'],
    });
    await syncAccountProviders(fake.runtime);
    expect(fake.registered()).toEqual(['anthropic', 'cursor', 'anthropic#2']);
    expect(fake.unregistered).toEqual(['cursor#2']);
  });

  // worker 不跑 syncAccountProviders，只按需 ensureAccountProvider——闸门漏在这里的话，
  // settings 里残留的 cursor#2 条目会让 worker 注册出共用裸 cursor token 的克隆
  it('worker 的按需注册同样拦住 Cursor 克隆，其他 provider 不受影响', () => {
    const fake = fakeRuntime({ builtins: ['anthropic', 'cursor'], credentials: [] });
    ensureAccountProvider(fake.runtime, 'cursor#2');
    expect(fake.registered()).toEqual(['anthropic', 'cursor']);
    ensureAccountProvider(fake.runtime, 'anthropic#2');
    expect(fake.registered()).toEqual(['anthropic', 'cursor', 'anthropic#2']);
  });

  it('克隆返回的模型 provider 字段是合成 id（否则推理会串到别的账号）', async () => {
    const fake = fakeRuntime({ builtins: ['anthropic'], credentials: ['anthropic#2'] });
    await syncAccountProviders(fake.runtime);
    const clone = fake.runtime.getProvider('anthropic#2');
    expect(clone?.id).toBe('anthropic#2');
    expect(clone?.getModels().map((model) => model.provider)).toEqual(['anthropic#2']);
  });

  it('凭证已被删掉的克隆会被注销，不留悬空 provider', async () => {
    const fake = fakeRuntime({
      builtins: ['anthropic'],
      credentials: ['anthropic#2', 'anthropic#3'],
    });
    await syncAccountProviders(fake.runtime);
    const stale = fakeRuntime({
      builtins: ['anthropic', 'anthropic#2', 'anthropic#3'],
      credentials: ['anthropic#3'],
    });
    await syncAccountProviders(stale.runtime);
    expect(stale.unregistered).toEqual(['anthropic#2']);
    expect(stale.registered()).toEqual(['anthropic', 'anthropic#3']);
  });

  it('基础 provider 缺失（如插件未注册）时跳过而不抛', async () => {
    const fake = fakeRuntime({ builtins: [], credentials: ['google-antigravity#2'] });
    await expect(syncAccountProviders(fake.runtime)).resolves.toBeUndefined();
    expect(fake.registered()).toEqual([]);
  });
});
