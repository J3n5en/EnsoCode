/**
 * 界面是否跑在远程客户端（网页版 / 手机 / 桌面节点层）。
 *
 * 远程只有 `nodes:` / `window:` / `notification:` 走所在电脑的 main，其余 IPC 经隧道回宿主
 * 并按 `remoteRenderer/channels.ts` 的白名单裁决。只允许宿主执行的通道在远程会直接抛错，
 * 所以这类调用必须在发起前跳过，而不是靠 catch 吞掉——吞掉会让按钮变成静默失败。
 */
export function isRemoteClient(): boolean {
  return Boolean(window.electronAPI?.remote);
}
