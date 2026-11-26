import { type Locale, translate } from '@shared/i18n';
import {
  SHELL_INTEGRATIONS,
  type ShellIntegration,
  shellIntegrationMenuLabel,
} from '@shared/shellIntegration';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { app, Menu, type MenuItemConstructorOptions } from 'electron';
import { readShellIntegrationStatusSync, shellIntegrationAction } from '../desktop/shellCommand';
import { openSettingsInMainWindow } from '../windows/mainSettings';
import type { AppRestartState } from './appRestart';
import { sendToLocalMain } from './renderers';

export const APP_DISPLAY_NAME = 'EnsoCode';

/** 菜单动作由 Main 入口注入：appMenu 不直接依赖退出 / 重启流程 */
export interface AppMenuActions {
  /** 整个应用优雅退出后重新打开；进行中重复调用无副作用 */
  restartApp(): void;
  restartState(): AppRestartState;
  reportError(message: string): void;
}

let appMenuActions: AppMenuActions | undefined;

export function setAppMenuActions(actions: AppMenuActions): void {
  appMenuActions = actions;
}

function restartAppFromMenu(locale: Locale, actions: AppMenuActions): void {
  try {
    actions.restartApp();
  } catch (error) {
    console.error('[app-menu] 重启失败:', error);
    const reason = error instanceof Error ? error.message : String(error);
    actions.reportError(translate(locale, 'Restart failed: {{error}}', { error: reason }));
  }
}

function restartMenuItem(locale: Locale, actions: AppMenuActions): MenuItemConstructorOptions {
  switch (actions.restartState()) {
    case 'waiting-for-tools':
      return {
        label: translate(locale, 'Waiting for running commands to restart…'),
        enabled: false,
      };
    case 'restarting':
      return { label: translate(locale, 'Restarting…'), enabled: false };
    default:
      return {
        label: translate(locale, 'Restart'),
        click: () => restartAppFromMenu(locale, actions),
      };
  }
}

/**
 * Electron 默认 appMenu 用 app.name（package.json name = enso-code）拼 About/Hide/Quit。
 * 不能改 app.name：macOS safeStorage 钥匙串条目按 app.name 命名，改了会解不开已存凭据。
 *
 * 侧栏项不带加速键：⌘B 由渲染层统一处理（可改绑、跨平台一致），
 * 菜单项只作鼠标入口，点击发 WINDOW_TOGGLE_SIDEBAR。
 * 曾挂 accelerator='CmdOrCtrl+B'：macOS 菜单吞键后 click 与渲染层 keydown 双路径
 * 难以协调（#338 的 guard 误杀键盘路径），单路径后这个矛盾不存在。
 */
export function macAppMenuTemplate(
  locale: Locale = 'en',
  packaged = app.isPackaged,
  installed: Record<ShellIntegration, boolean> = readShellIntegrationStatusSync(),
  actions: AppMenuActions | undefined = appMenuActions
): MenuItemConstructorOptions[] {
  return [
    {
      label: APP_DISPLAY_NAME,
      submenu: [
        { role: 'about', label: `About ${APP_DISPLAY_NAME}` },
        { type: 'separator' },
        { label: translate(locale, 'Settings…'), click: () => openSettingsInMainWindow() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${APP_DISPLAY_NAME}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        ...(actions ? [restartMenuItem(locale, actions)] : []),
        { role: 'quit', label: `Quit ${APP_DISPLAY_NAME}` },
      ],
    },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          label: translate(locale, 'Show or hide sidebar'),
          click: () => sendToLocalMain(IPC_CHANNELS.WINDOW_TOGGLE_SIDEBAR),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    ...(packaged
      ? [
          {
            label: translate(locale, 'Integrations'),
            submenu: SHELL_INTEGRATIONS.map((kind) => ({
              label: translate(locale, shellIntegrationMenuLabel(kind, installed[kind])),
              click: () =>
                void shellIntegrationAction(kind, locale).then(() => installAppMenu(locale)),
            })),
          },
        ]
      : []),
    { role: 'windowMenu' },
  ];
}

export function installAppMenu(locale: Locale): void {
  if (process.platform !== 'darwin') return;
  Menu.setApplicationMenu(Menu.buildFromTemplate(macAppMenuTemplate(locale)));
}
