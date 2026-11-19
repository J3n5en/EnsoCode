import { type Locale, translate } from '@shared/i18n';
import {
  SHELL_INTEGRATIONS,
  type ShellIntegration,
  shellIntegrationMenuLabel,
} from '@shared/shellIntegration';
import { app, Menu, type MenuItemConstructorOptions } from 'electron';
import { readShellIntegrationStatusSync, shellIntegrationAction } from '../desktop/shellCommand';
import type { GracefulRestartRequest } from './gracefulWorkerRestart';

export const APP_DISPLAY_NAME = 'EnsoCode';

/** 菜单动作由 Main 入口注入：appMenu 不直接依赖 agent worker 宿主 */
export interface AppMenuActions {
  /** 请当前 agent worker 在安全点换新进程（不重启窗口） */
  restartAgent(): GracefulRestartRequest;
  notify(message: string): void;
}

let appMenuActions: AppMenuActions | undefined;

export function setAppMenuActions(actions: AppMenuActions): void {
  appMenuActions = actions;
}

function restartAgentFromMenu(locale: Locale, actions: AppMenuActions): void {
  const result = actions.restartAgent();
  if (result === 'no-session') {
    actions.notify(translate(locale, 'No session to restart right now.'));
  } else if (result === 'already-restarting') {
    actions.notify(
      translate(
        locale,
        'A restart is already in progress and will finish once the running tool calls end.'
      )
    );
  }
}

/**
 * Electron 默认 appMenu 用 app.name（package.json name = enso-code）拼 About/Hide/Quit。
 * 不能改 app.name：macOS safeStorage 钥匙串条目按 app.name 命名，改了会解不开已存凭据。
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
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${APP_DISPLAY_NAME}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        ...(actions
          ? [
              {
                label: translate(locale, 'Restart'),
                click: () => restartAgentFromMenu(locale, actions),
              },
            ]
          : []),
        { role: 'quit', label: `Quit ${APP_DISPLAY_NAME}` },
      ],
    },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
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
