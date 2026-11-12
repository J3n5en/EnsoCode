/**
 * 应用层心跳：NAT/中间设备静默回收空闲 TCP 后，半开连接的 readyState 永远是
 * OPEN、close 事件永不触发，重连逻辑没机会启动。定期发 "ping"（中继以
 * setWebSocketAutoResponse 回 "pong"，不唤醒 DO），由 onDead 主动关闭并走既有
 * 重连路径（半开时 close 事件可能永不到达，调用方不能只 ws.close() 干等）。
 *
 * 周期探测必须连续 2 次超时才判死：一次 pong 迟到、或宿主 Electron Main
 * 被长任务堵住 8s+，都不该把健康链路拆掉。第 1 次超时立刻再探一次（同一
 * timeout），收到任何消息（pong 或业务帧）清零计数。手动 probe(timeoutMs)
 * 仍是单次超时即判死，用于回前台/唤醒/网络恢复时尽快发现半开链。
 */

const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 8_000;
/** 回前台探活：中继 pong 通常几十毫秒，半开链别干等 3s */
export const VISIBILITY_PROBE_MS = 500;

export interface Heartbeat {
  /** 立即探测一次（回前台/睡眠唤醒/网络恢复时用），不等下个周期 */
  probe(timeoutMs?: number): void;
  stop(): void;
}

export function attachHeartbeat(
  ws: WebSocket,
  onDead: () => void,
  onRtt?: (ms: number) => void
): Heartbeat {
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let pingAt: number | null = null;
  let misses = 0;
  let stopped = false;
  const alive = (): void => {
    if (deadline) clearTimeout(deadline);
    deadline = null;
    misses = 0;
  };
  const ping = (timeoutMs: number, maxMisses: number): void => {
    if (stopped || ws.readyState !== 1) return;
    pingAt = Date.now();
    try {
      ws.send('ping');
    } catch {}
    if (deadline) clearTimeout(deadline);
    deadline = setTimeout(() => {
      deadline = null;
      if (stopped) return;
      misses += 1;
      if (misses < maxMisses) {
        ping(timeoutMs, maxMisses);
        return;
      }
      onDead();
    }, timeoutMs);
  };
  const probe = (timeoutMs = HEARTBEAT_TIMEOUT_MS): void => {
    ping(timeoutMs, 1);
  };
  const periodic = (): void => {
    if (deadline) return;
    ping(HEARTBEAT_TIMEOUT_MS, 2);
  };
  const onMessage = (event: Event): void => {
    alive();
    const data = (event as MessageEvent).data;
    if (data === 'pong' && pingAt !== null) {
      onRtt?.(Date.now() - pingAt);
      pingAt = null;
    }
  };
  // 收到任何消息（含 pong、业务帧）都算存活；仅 pong 计 RTT
  ws.addEventListener('message', onMessage);
  const onOpen = (): void => periodic();
  ws.addEventListener('open', onOpen);
  if (ws.readyState === 1) periodic();
  const timer = setInterval(periodic, HEARTBEAT_INTERVAL_MS);
  return {
    probe,
    stop() {
      stopped = true;
      clearInterval(timer);
      alive();
      pingAt = null;
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('open', onOpen);
    },
  };
}
