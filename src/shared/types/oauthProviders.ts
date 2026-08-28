/**
 * 订阅登录（OAuth）的跨进程契约。
 *
 * 多账号模型：pi 的 auth.json schema 是 `Record<providerId, Credential>`，每个 provider 只有
 * 一条凭证。要让同一个厂商挂多个账号，我们用**合成 provider id** 作为 auth.json 的键：
 *   - 第一个账号沿用裸 `<providerId>`（与 pi CLI 及本应用旧版本写入的数据兼容）
 *   - 后续账号是 `<providerId>#<n>`
 * 这个键即 `OauthAccount.key`，Main 侧据它 `registerNativeProvider` 一份克隆 provider，
 * 从而让推理时按请求确定性地选中对应账号的凭证——不依赖任何「当前账号」可变状态
 * （agent worker 是单进程装全部会话，共享可变状态在并发下必然串号）。
 */

/** 一个已登录的订阅账号 */
export interface OauthAccount {
  /** auth.json 的键，同时是合成 provider id；`ModelProvider.oauthAccountKey` 存的就是它 */
  key: string;
  /** 基础 provider id（如 'anthropic'），即 pi catalog 里的原始 id */
  providerId: string;
  /** 账号邮箱，从 JWT claims 或厂商 userinfo 端点 best-effort 取得 */
  email?: string;
  /**
   * 订阅档位（如 'max'、'pro'）。
   * 厂商原文经 `sanitizeOauthLabel` 截到 `OAUTH_LABEL_MAX_LENGTH`。
   */
  plan?: string;
}

/** pi 内置 + 本应用注册的 OAuth provider 展示信息（Main 汇总，Renderer 只读） */
export interface OauthProviderInfo {
  /** 基础 provider id */
  id: string;
  name: string;
  /** 登录入口文案，如 "Sign in with SuperGrok or X Premium" */
  loginLabel?: string;
  /** 是否允许同一厂商同时登录多个账号 */
  supportsMultipleAccounts: boolean;
  /** 已登录账号；空数组即未登录。⚠️ 不要用布尔判断登录态 */
  accounts: OauthAccount[];
  /** 内置 catalog 模型 id */
  models: string[];
}

/** 订阅额度窗口（如 Claude 5h/7d、Codex primary/secondary、Antigravity daily/weekly） */
export interface OauthUsageWindow {
  /**
   * 窗口名。厂商原文经 `sanitizeOauthLabel` 截到 `OAUTH_LABEL_MAX_LENGTH`。
   */
  label: string;
  /** 已用百分比 0-100 */
  usedPercent: number;
  /** 重置时间 epoch ms */
  resetsAt?: number;
}

/** 单个账号的额度详情（best-effort，取不到的字段缺省）。按 `OauthAccount.key` 查询 */
export interface OauthAccountUsage {
  key: string;
  windows: OauthUsageWindow[];
  /** 拉取失败时的原因，便于界面区分「没额度信息」与「拉取挂了」 */
  error?: string;
}

/** 登录流程中需要用户输入的 prompt（Main → Renderer，经 respond 回传） */
export interface OauthLoginPrompt {
  requestId: string;
  type: 'text' | 'secret' | 'select' | 'manual_code';
  message: string;
  placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
}

/** 登录流程事件（Main → Renderer 单向推送） */
export type OauthLoginEvent =
  | { type: 'info'; message: string }
  | { type: 'auth_url'; url: string; instructions?: string }
  | { type: 'device_code'; userCode: string; verificationUri: string }
  | { type: 'progress'; message: string }
  | { type: 'prompt'; prompt: OauthLoginPrompt }
  | { type: 'prompt-cancel'; requestId: string }
  /** 登录成功；account 是这次新增（或覆盖）的那个账号 */
  | { type: 'done'; providerId: string; account: OauthAccount }
  | { type: 'error'; message: string };

/**
 * 厂商 `plan` / `OauthUsageWindow.label` 的上游长度上限。
 *
 * 渲染侧：ModelPicker 把 plan 截到 16，状态栏把窗口 label 截到 24。
 * 这里取 32——略宽于两者，挡住无界厂商串写入 sidecar / IPC，
 * 又不比界面展示更狠。控制字符一并剔除（与 ModelPicker 的 sanitizeAccountText 同意图）。
 */
export const OAUTH_LABEL_MAX_LENGTH = 32;

/**
 * 探测结果里给界面/sidecar 的短文案：去掉控制字符、trim，再硬截到
 * `OAUTH_LABEL_MAX_LENGTH`。数据层不加省略号——展示截断仍由渲染侧负责。
 */
export function sanitizeOauthLabel(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
  }
  out = out.trim();
  return out.length > OAUTH_LABEL_MAX_LENGTH ? out.slice(0, OAUTH_LABEL_MAX_LENGTH) : out;
}

/** 首个账号沿用裸 providerId，后续为 `<providerId>#<n>` */
export const accountKeyFor = (providerId: string, ordinal: number): string =>
  ordinal <= 0 ? providerId : `${providerId}#${ordinal + 1}`;

/** 从账号 key 反解基础 provider id */
export const providerIdOfAccountKey = (key: string): string => {
  const hash = key.indexOf('#');
  return hash === -1 ? key : key.slice(0, hash);
};
