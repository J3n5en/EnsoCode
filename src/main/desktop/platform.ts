/**
 * 桌面宿主的平台实现：进程级能力直接映射 Electron。
 * 构建时 `@platform` 解析到这里；tsc 解析到 platform/api.ts 做类型约束。
 */
import {
  app,
  ClipboardItem,
  clipboard as electronClipboard,
  ipcMain,
  Notification,
  nativeImage,
  net,
  powerMonitor,
  powerSaveBlocker,
  safeStorage,
  session,
  shell,
  utilityProcess,
} from 'electron';
import agentWorkerPath from '../../agent/index?modulePath';
import memoryWorkerPath from '../../memoryService/index?modulePath';
import pluginHostPath from '../../pluginHost/index?modulePath';
import type { DecodedImage, ProcessMetric } from '../platform/types';
import { showSystemNotification } from './systemNotification';

export const hostKind = 'desktop' as const;
export const resourcesPath = process.resourcesPath;
export {
  agentWorkerPath,
  app,
  ipcMain,
  memoryWorkerPath,
  net,
  pluginHostPath,
  powerMonitor,
  powerSaveBlocker,
  safeStorage,
  session,
  shell,
  utilityProcess,
};

/** Electron 44 起剪贴板全异步；原始格式经 osclipboard 自定义 MIME 写入 */
export const clipboard = {
  writeText: (text: string) => electronClipboard.writeText(text),
  writeBuffer: (format: string, buffer: Buffer) =>
    electronClipboard.write([
      new ClipboardItem({
        [`electron application/osclipboard;format="${format}"`]: new Blob([new Uint8Array(buffer)]),
      }),
    ]),
};

export const notification = {
  isSupported: () => Notification.isSupported(),
  show: (options: { title: string; body: string }) =>
    showSystemNotification({ title: options.title, body: options.body }),
};

export const images = {
  fromBuffer(data: Buffer): DecodedImage | null {
    const image = nativeImage.createFromBuffer(data);
    return image.isEmpty() ? null : image;
  },
};

export function processMetrics(): ProcessMetric[] {
  return app.getAppMetrics() as ProcessMetric[];
}
