import type { IceServerEntry } from '@enso/pair';

/** 紧急开关：关掉后 host 不声明 direct-v1，所有设备退回纯中继 */
export const PAIR_DIRECT_ENABLED = true;

/**
 * STUN 列表由 host 经 host-info 下发，guest（手机 PWA / 另一台桌面）跟随，换地址只改这里。
 * Cloudflare 与中继同信任域；国内两家为社区公开地址、无 SLA，并行查询，失效只是少一份候选。
 * 不配 TURN：中继本身就是兜底。
 */
export const PAIR_STUN_SERVERS: IceServerEntry[] = [
  { urls: ['stun:stun.cloudflare.com:3478'] },
  { urls: ['stun:stun.miwifi.com:3478'] },
  { urls: ['stun:stun.chat.bilibili.com:3478'] },
];
