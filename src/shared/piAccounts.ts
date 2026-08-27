/**
 * 多账号的合成 provider 注册（Main 与 agent worker 共用）。
 *
 * 背景见 `types/oauthProviders.ts`：auth.json 是 `Record<providerId, Credential>`，
 * 同一厂商的第 2+ 个账号存在合成键 `<providerId>#<n>` 下。要让推理时能选到那条凭证，
 * 必须在 ModelRuntime 上把该键注册成一份基础 provider 的克隆。
 *
 * 为什么放在 shared：Main 与 agent worker 是两个进程、两个 ModelRuntime 实例，
 * 只共用同一份 auth.json。worker 侧不注册就 `getModel('anthropic#2', ...)` 取不到东西，
 * 两边必须跑同一套逻辑，而 `src/agent/` 只准 import `@shared` 与 pi sdk。
 */
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { accountKeyFor, providerIdOfAccountKey } from './types/oauthProviders';

// pi-ai 不在依赖树顶层，provider 类型从 ModelRuntime 的公开签名结构化提取
type PiProvider = ReturnType<ModelRuntime['getProviders']>[number];

/** 本模块用到的 ModelRuntime 子集；收窄签名也让单测能用最小替身 */
export type AccountProviderRuntime = Pick<
  ModelRuntime,
  | 'getProvider'
  | 'getProviders'
  | 'registerNativeProvider'
  | 'unregisterProvider'
  | 'listCredentials'
>;

/** 只有本应用会造带 `#` 的 provider id，据此可无额外记账地识别克隆 */
const isAccountClone = (providerId: string): boolean => providerId.includes('#');

/**
 * 把账号 key 注册成基础 provider 的克隆。基础 provider 不存在时返回 false。
 *
 * ⚠️ 必须同时重写 `getModels`：`createProvider` 返回的是纯对象，`getModels` 是自有属性，
 * 只改 `clone.id` 的话它返回的模型 `provider` 字段仍是基础 id，而推理时
 * `runtime.getAuth(model)` 按 `model.provider` 解析凭证——会静默读到另一个账号的 token。
 * 实测见 `temp/multiaccount-probe/probe2.mjs`。
 */
export function registerAccountProvider(
  runtime: AccountProviderRuntime,
  accountKey: string
): boolean {
  const base = runtime.getProvider(providerIdOfAccountKey(accountKey));
  if (!base) return false;
  // pi 的 provider 是 createProvider 产出的纯对象（无私有字段，方法都是闭包），
  // 所以浅拷贝出来的克隆对推理/登录/刷新全都是完整可用的。
  // id 与 getModels 在 Provider 上是只读的，只能在建对象时一次性覆盖
  const clone: PiProvider = Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    id: accountKey,
    getModels: () => base.getModels().map((model) => ({ ...model, provider: accountKey })),
  });
  runtime.registerNativeProvider(clone);
  return true;
}

/** 确保该账号 key 可用（裸 key 直接用 pi 内置 provider，无需克隆） */
export function ensureAccountProvider(runtime: AccountProviderRuntime, accountKey: string): void {
  if (!isAccountClone(accountKey)) return;
  if (runtime.getProvider(accountKey)) return;
  registerAccountProvider(runtime, accountKey);
}

/**
 * 按 auth.json 现状全量对齐克隆注册：缺的补上、已失效的注销。
 * Main 侧在 runtime 建好以及每次登录/登出后调用；worker 侧按需 `ensureAccountProvider` 即可。
 */
export async function syncAccountProviders(runtime: AccountProviderRuntime): Promise<void> {
  const credentials = await runtime.listCredentials();
  const wanted = new Set(
    credentials.map((info) => info.providerId).filter((key) => isAccountClone(key))
  );
  for (const provider of runtime.getProviders()) {
    if (isAccountClone(provider.id) && !wanted.has(provider.id)) {
      runtime.unregisterProvider(provider.id);
    }
  }
  for (const key of wanted) ensureAccountProvider(runtime, key);
}

/** 账号 key 的序号（`accountKeyFor` 的逆）：裸 key 为 0，`<id>#n` 为 n-1 */
export function ordinalOfAccountKey(accountKey: string): number {
  const hash = accountKey.indexOf('#');
  if (hash === -1) return 0;
  const parsed = Number.parseInt(accountKey.slice(hash + 1), 10);
  return Number.isFinite(parsed) && parsed >= 2 ? parsed - 1 : 0;
}

/**
 * 下一个可用账号 key：**序号严格递增，不回收已登出的空位**。
 *
 * 为什么不复用空位：settings 里的 provider 条目存的就是这个 key。若「登出 anthropic
 * 后新账号又拿到 anthropic」，任何残留的旧条目会静默绑到新账号的凭证上——错账号发请求
 * 是无声故障。递增分配换来的代价只是 auth.json 里留个空号，完全可接受。
 */
export function nextAccountKey(providerId: string, existingKeys: readonly string[]): string {
  const ordinals = existingKeys
    .filter((key) => providerIdOfAccountKey(key) === providerId)
    .map(ordinalOfAccountKey);
  return accountKeyFor(providerId, ordinals.length === 0 ? 0 : Math.max(...ordinals) + 1);
}
