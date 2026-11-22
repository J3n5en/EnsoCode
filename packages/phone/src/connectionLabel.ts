import { formatRttMs } from '@shared/pair/rtt';
import type { ConnState } from './client';

export const CONN_STATE_LABEL: Record<ConnState, string> = {
  connecting: '连接中…',
  online: '已连接',
  'host-offline': '桌面端离线',
  unauthorized: '配对已失效',
  replaced: '已在其他页面打开',
  offline: '重连中…',
};

export function formatOnlineConnectionLabel(
  transport: 'relay' | 'direct',
  rttMs: number | null
): string {
  const via = transport === 'direct' ? '直连' : '中继';
  const rtt = formatRttMs(rttMs);
  return rtt ? `已连接 · ${via} · ${rtt}` : `已连接 · ${via}`;
}
