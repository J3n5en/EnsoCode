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

/** 模块级持有 token、无法按请求隔离凭证的 provider 只能保留一个账号 */
export const SINGLE_ACCOUNT_PROVIDER_IDS: Readonly<Record<string, true>> = { cursor: true };

/**
 * 该 provider 是否支持同一厂商多账号并存。
 *
 * Cursor 的 `@rahularya01/pi-cursor` 在 `dist/index.js` 的 `WS()` 闭包中持有模块级
 * access token，刷新时还固定读取 `readStoredCredential("cursor")`；它不会逐请求消费
 * `options.apiKey`，所以克隆出的 `<id>#n` 会静默共用另一个账号的订阅与额度。
 * Antigravity 则在 `src/shared/providers/antigravity.ts:1380-1395` 逐请求解析
 * `options.apiKey`，因此可以安全隔离多个账号。
 */
export function supportsMultipleAccounts(providerId: string): boolean {
  return SINGLE_ACCOUNT_PROVIDER_IDS[providerIdOfAccountKey(providerId)] !== true;
}

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
  // 闸门落在这个入口而不只落在 syncAccountProviders：worker 侧按需注册走的是这里，
  // 不经过全量对齐。少了这道判断，settings 里残留的 cursor#2 条目会让 worker 注册出
  // 共用裸 cursor token 的克隆，请求与额度静默算到另一个订阅上。
  if (!supportsMultipleAccounts(accountKey)) return;
  if (runtime.getProvider(accountKey)) return;
  registerAccountProvider(runtime, accountKey);
}

/**
 * 按 auth.json 现状全量对齐克隆注册：缺的补上、已失效的注销。
 * Main 侧在 runtime 建好以及每次登录/登出后调用；worker 侧按需 `ensureAccountProvider` 即可。
 */
export async function syncAccountProviders(runtime: AccountProviderRuntime): Promise<void> {
  const credentials = await runtime.listCredentials();
  // 外部 pi CLI 仍可能写入 cursor#2；宁可让这条账号不可用，也不能注册一个会静默
  // 共用裸 cursor token、进而把请求和额度算到另一个订阅上的克隆。此前注册过的克隆
  // 因不在 wanted 中，会在下面统一注销。
  const wanted = new Set(
    credentials
      .map((info) => info.providerId)
      .filter((key) => isAccountClone(key) && supportsMultipleAccounts(key))
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
