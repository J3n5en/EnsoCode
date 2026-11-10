import { type Locale, translate } from '@shared/i18n';
import { SHELL_INTEGRATION_MENU_LABELS, SHELL_INTEGRATIONS } from '@shared/shellIntegration';
import { app, Menu, type MenuItemConstructorOptions } from 'electron';
import { installShellIntegration } from '../desktop/shellCommand';

export const APP_DISPLAY_NAME = 'EnsoCode';

/**
 * Electron 默认 appMenu 用 app.name（package.json name = enso-code）拼 About/Hide/Quit。
 * 不能改 app.name：macOS safeStorage 钥匙串条目按 app.name 命名，改了会解不开已存凭据。
 */
export function macAppMenuTemplate(
  locale: Locale = 'en',
  packaged = app.isPackaged
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
              label: translate(locale, SHELL_INTEGRATION_MENU_LABELS[kind]),
              click: () => void installShellIntegration(kind, locale),
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
