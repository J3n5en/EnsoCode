import type { RemoteLinkState } from '@shared/remoteBridge';
import { formatRttMs } from './rtt';

const OFFLINE_KEY: Record<Exclude<RemoteLinkState, 'online'>, string> = {
  connecting: 'Connecting…',
  'host-offline': 'Desktop is offline',
  unauthorized: 'Pairing expired',
  replaced: 'Open in another page',
  offline: 'Reconnecting…',
};

/** 状态点颜色：在线 / 正在连 / 连不上 */
export function linkTone(state: RemoteLinkState): 'ok' | 'pending' | 'error' {
  if (state === 'online') return 'ok';
  return state === 'connecting' || state === 'offline' ? 'pending' : 'error';
}

/** 完整版侧栏副标题。文案键交给调用方翻译，和精简版「已连接 · 中继 · 32ms」同一结构 */
export function formatLinkSubtitle(
  status: { state: RemoteLinkState; transport: 'relay' | 'direct'; rttMs: number | null },
  t: (key: string) => string
): string {
  if (status.state !== 'online') return t(OFFLINE_KEY[status.state]);
  const via = status.transport === 'direct' ? t('Direct link') : t('Via relay');
  const rtt = formatRttMs(status.rttMs);
  return rtt ? `${t('Connected')} · ${via} · ${rtt}` : `${t('Connected')} · ${via}`;
}
