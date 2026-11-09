export type QoderMode = "global" | "cn";

export interface QoderRegionConfig {
  mode: QoderMode;
  providerID: "qoder" | "qoder-cn";
  baseUrl: string;
  openApiUrl: string;
  centerUrl: string;
  manageUrl: string;
  patManageUrl: string;
  deviceLoginUrl?: string;
  modelCacheFile: string;
  patEnvNames: readonly string[];
  loginName: string;
  userNameFallback: string;
  userEmailFallback: string;
  usageTitle: string;
  supportsBrowserLogin: boolean;
}

const QODER_REGIONS: Record<QoderMode, QoderRegionConfig> = {
  global: {
    mode: "global",
    providerID: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    openApiUrl: "https://openapi.qoder.sh",
    centerUrl: "https://center.qoder.sh",
    manageUrl: "https://qoder.com",
    patManageUrl: "https://qoder.com/account/integrations",
    deviceLoginUrl: "https://qoder.com/device/selectAccounts",
    modelCacheFile: "qoder-models-cache.json",
    patEnvNames: ["QODER_API_KEY", "QODER_PERSONAL_ACCESS_TOKEN", "QODER_PAT"],
    loginName: "Qoder (Browser OAuth / PAT)",
    userNameFallback: "Qoder User",
    userEmailFallback: "user@qoder.com",
    usageTitle: "Qoder AI Plan",
    supportsBrowserLogin: true,
  },
  cn: {
    mode: "cn",
    providerID: "qoder-cn",
    baseUrl: "https://gateway.qoder.com.cn/",
    openApiUrl: "https://openapi.qoder.com.cn",
    centerUrl: "https://gateway.qoder.com.cn",
    manageUrl: "https://qoder.com.cn",
    patManageUrl: "https://qoder.com.cn/account/integrations",
    modelCacheFile: "qoder-cn-models-cache.json",
    patEnvNames: ["QODERCN_API_KEY", "QODERCN_PERSONAL_ACCESS_TOKEN", "QODERCN_PAT"],
    loginName: "Qoder CN (PAT)",
    userNameFallback: "Qoder CN User",
    userEmailFallback: "user@qoder.com.cn",
    usageTitle: "Qoder CN Plan",
    supportsBrowserLogin: false,
  },
};

export const QODER_MODES: readonly QoderMode[] = ["global", "cn"];

export function getQoderRegionConfig(mode: QoderMode): QoderRegionConfig {
  return QODER_REGIONS[mode];
}

export function getQoderBaseUrl(mode: QoderMode): string {
  return getQoderRegionConfig(mode).baseUrl;
}

/**
 * Chat traffic may be routed to a different node than the catalog. Qoder's
 * own CLI resolves this per account (region/endpoints), and the node it picks
 * does not always match `inferNodes`: using the infer node for agent chat
 * returns `403 code 110 "Billing daily count exceeded"` for some accounts
 * while the same account succeeds on the node the CLI selected.
 */
const chatBaseUrlOverrides = new Map<QoderMode, string>();

export function getQoderChatBaseUrl(mode: QoderMode): string {
  return chatBaseUrlOverrides.get(mode) ?? getQoderBaseUrl(mode);
}

export function setQoderChatBaseUrl(mode: QoderMode, url: string | undefined): void {
  if (!url) {
    chatBaseUrlOverrides.delete(mode);
    return;
  }
  chatBaseUrlOverrides.set(mode, url.endsWith("/") ? url : `${url}/`);
}

export function clearQoderChatBaseUrlOverrides(): void {
  chatBaseUrlOverrides.clear();
}

export function getQoderModelListURL(mode: QoderMode): string {
  return `${getQoderBaseUrl(mode)}algo/api/v2/model/list?Encode=1`;
}

export function getQoderChatURL(mode: QoderMode): string {
  return `${getQoderChatBaseUrl(mode)}algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
}

export function getQoderExchangeURL(mode: QoderMode): string {
  return `${getQoderRegionConfig(mode).openApiUrl}/api/v1/jobToken/exchange`;
}

export function getQoderUserInfoURL(mode: QoderMode): string {
  return `${getQoderRegionConfig(mode).openApiUrl}/api/v1/userinfo`;
}

export function getQoderUsageURL(mode: QoderMode): string {
  return `${getQoderRegionConfig(mode).openApiUrl}/api/v2/quota/usage`;
}

export function getQoderRefreshURL(mode: QoderMode): string {
  return `${getQoderRegionConfig(mode).centerUrl}/algo/api/v3/user/refresh_token`;
}

export function getQoderDeviceLoginURL(codeChallenge: string, machineID: string, nonce: string): string {
  const baseUrl = getQoderRegionConfig("global").deviceLoginUrl;
  if (!baseUrl) throw new Error("Qoder browser login URL is not configured");
  return `${baseUrl}?challenge=${codeChallenge}&challenge_method=S256&machine_id=${machineID}&nonce=${nonce}`;
}

export function getQoderDevicePollURL(nonce: string, codeVerifier: string): string {
  const baseUrl = getQoderRegionConfig("global").openApiUrl;
  return `${baseUrl}/api/v1/deviceToken/poll?nonce=${encodeURIComponent(nonce)}&verifier=${encodeURIComponent(codeVerifier)}&challenge_method=S256`;
}
