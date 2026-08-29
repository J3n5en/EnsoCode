/**
 * 应用层心跳：NAT/中间设备静默回收空闲 TCP 后，半开连接的 readyState 永远是
 * OPEN、close 事件永不触发，重连逻辑没机会启动。定期发 "ping"（中继以
 * setWebSocketAutoResponse 回 "pong"，不唤醒 DO），到点没等到任何消息就判死，
 * 由 onDead 主动关闭并走既有重连路径（半开时 close 事件可能永不到达，
 * 调用方不能只 ws.close() 干等）。
 */

const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

export interface Heartbeat {
  /** 立即探测一次（回前台/睡眠唤醒/网络恢复时用），不等下个周期 */
  probe(): void;
  stop(): void;
}

export function attachHeartbeat(ws: WebSocket, onDead: () => void): Heartbeat {
  let deadline: ReturnType<typeof setTimeout> | null = null;
  const alive = (): void => {
    if (deadline) clearTimeout(deadline);
    deadline = null;
  };
  const probe = (): void => {
    if (ws.readyState !== 1) return;
    try {
      ws.send('ping');
    } catch {}
    deadline ??= setTimeout(onDead, HEARTBEAT_TIMEOUT_MS);
  };
  // 收到任何消息（含 pong、业务帧）都算存活
  ws.addEventListener('message', alive);
  const timer = setInterval(probe, HEARTBEAT_INTERVAL_MS);
  return {
    probe,
    stop() {
      clearInterval(timer);
      alive();
      ws.removeEventListener('message', alive);
    },
  };
}
