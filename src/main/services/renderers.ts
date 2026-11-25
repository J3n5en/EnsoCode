import type { RendererContents } from '@platform';
import {
  hasRemoteMain,
  isRemoteMainSender,
  remoteSenderById,
  sendToRemoteRenderers,
} from './remoteRenderer/senders';
import { localUi } from './uiHost';

/** 本地主窗口的 renderer；服务器上恒为 null */
export function localMainContents(): RendererContents | null {
  return localUi()?.mainContents() ?? null;
}

export function isMainRendererAlive(): boolean {
  return localMainContents() !== null || hasRemoteMain();
}

/** 桌面主窗口与远程浏览器里的主界面 renderer 同权 */
export function isMainRenderer(webContentsId: number): boolean {
  if (isRemoteMainSender(webContentsId)) return true;
  return localMainContents()?.id === webContentsId;
}

export function sendToLocalMain(channel: string, ...args: unknown[]): void {
  localMainContents()?.send(channel, ...args);
}

/** 按 webContents id 找本机窗口或远端页面 */
export function rendererById(id: number): RendererContents | null {
  return (
    localUi()
      ?.allContents()
      .find((contents) => contents.id === id) ??
    remoteSenderById(id) ??
    null
  );
}

export function broadcastToRenderers(channel: string, ...args: unknown[]): void {
  for (const contents of localUi()?.allContents() ?? []) contents.send(channel, ...args);
  sendToRemoteRenderers(channel, args);
}

export function anyRendererFocused(): boolean {
  return localUi()?.anyFocused() ?? false;
}

/** 本机窗口在前台、最近 withinMs 内有键盘或鼠标输入：用户正在操作 */
export function userRecentlyActive(withinMs: number): boolean {
  const ui = localUi();
  return Boolean(ui?.anyFocused() && ui.inputIdleMs() < withinMs);
}

export function focusMainRenderer(): void {
  localUi()?.focusMain();
}
