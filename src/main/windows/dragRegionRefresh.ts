/**
 * macOS 透明窗口的点击形状按已绘制内容缓存（窗口服务对非不透明窗口从上次绘制推导命中区）。
 * 侧栏折叠动画把顶栏按钮移进红绿灯右侧后，缓存可能停在旧位置：按钮在 DOM 里完全正常，
 * 点上去却没有任何事件。invalidateShadow 会让窗口按当前内容重算形状。
 * 只接受该窗口工作区 renderer 的请求：主窗口 pin 了 workbench，发起方不是窗口自己的 webContents。
 */
export function shouldRefreshDragRegions(
  platform: string,
  senderId: number,
  windowContentsId: number | null
): boolean {
  return platform === 'darwin' && windowContentsId !== null && senderId === windowContentsId;
}
