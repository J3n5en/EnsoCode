import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { notification } from '@platform';
import { translate } from '@shared/i18n';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { readLocale } from '../../ipc/settings';
import { remoteSenders } from '../remoteRenderer/senders';
import {
  anyRendererFocused,
  isMainRenderer,
  isMainRendererAlive,
  sendToLocalMain,
} from '../renderers';
import { ElevationBroker } from './broker';
import { type ElevationServer, startElevationServer } from './server';

let shown = 0;

// 口令卡片只发给桌面主窗口与完整模式主界面；精简手机端、Bot、插件一概不发，通知里不带命令
export const elevationBroker = new ElevationBroker({
  canPresent: isMainRendererAlive,
  changed: (views) => {
    sendToLocalMain(IPC_CHANNELS.ELEVATION_CHANGED, views);
    for (const sender of remoteSenders()) {
      if (sender.kind === 'main') sender.send(IPC_CHANNELS.ELEVATION_CHANGED, views);
    }
    if (views.length > shown && !anyRendererFocused()) {
      notification.show({
        title: 'EnsoCode',
        body: translate(readLocale(), 'A command is waiting for the administrator password'),
      });
    }
    shown = views.length;
  },
});

export const canAnswerElevation = isMainRenderer;

let server: ElevationServer | null | undefined;

/** 启动 askpass 服务并返回 helper 路径（Windows 或启动失败返回 null） */
export function ensureElevationServer(): string | null {
  if (server !== undefined) return server?.askpassPath ?? null;
  server = null;
  if (process.platform === 'win32') return null;
  try {
    const started = startElevationServer({
      dir: mkdtempSync(path.join(tmpdir(), 'enso-elev-')),
      broker: elevationBroker,
      execPath: process.execPath,
    });
    started.ready.catch((error) =>
      console.warn(
        '[elevation] askpass server failed',
        error instanceof Error ? error.message : error
      )
    );
    process.once('exit', () => started.close());
    server = started;
  } catch (error) {
    console.warn(
      '[elevation] askpass server failed',
      error instanceof Error ? error.message : error
    );
  }
  return server?.askpassPath ?? null;
}
