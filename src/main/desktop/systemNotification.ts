import { execFile } from 'node:child_process';
import { app, Notification } from 'electron';
import { isVerifyLaunch } from '../windows/verifyLaunch';

declare global {
  /** 验收实例拦下的系统通知，脚本经 CDP 在主进程里读 */
  var __ensoVerifyNotifications: { title: string; body: string }[] | undefined;
}

export interface SystemNotificationOptions {
  title: string;
  body: string;
  icon?: string;
  /** 未打包的 mac 改走 osascript（未签名 app 的原生通知会被系统静默丢弃） */
  osascriptWhenUnsigned?: boolean;
}

/**
 * 本机系统通知的唯一出口。验收实例（ENSO_VERIFY=1、未打包）一条都不发，只记进
 * globalThis.__ensoVerifyNotifications。返回原生通知对象；走 osascript 或被拦下时返回 null。
 */
export function showSystemNotification(options: SystemNotificationOptions): Notification | null {
  const { title, body, icon } = options;
  if (isVerifyLaunch()) {
    globalThis.__ensoVerifyNotifications ??= [];
    globalThis.__ensoVerifyNotifications.push({ title, body });
    return null;
  }
  if (options.osascriptWhenUnsigned && process.platform === 'darwin' && !app.isPackaged) {
    const safeBody = body.replace(/[\\"]/g, ' ');
    const safeTitle = title.replace(/[\\"]/g, ' ');
    execFile('osascript', ['-e', `display notification "${safeBody}" with title "${safeTitle}"`]);
    return null;
  }
  if (!Notification.isSupported()) return null;
  const notification = new Notification({ title, body, silent: false, ...(icon ? { icon } : {}) });
  notification.show();
  return notification;
}
