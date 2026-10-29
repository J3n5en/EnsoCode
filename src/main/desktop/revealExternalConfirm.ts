import { type Locale, translate } from '@shared/i18n';
import { BrowserWindow, dialog, webContents } from 'electron';

const REVEAL_LABEL =
  process.platform === 'darwin'
    ? 'Reveal in Finder'
    : process.platform === 'linux'
      ? 'Open Containing Folder'
      : 'Reveal in File Explorer';

/** 未被本会话写过的工作区外文件：原生确认框显示完整真实路径，默认取消。 */
export async function confirmRevealExternal(
  senderId: number,
  file: string,
  locale: Locale
): Promise<boolean> {
  const contents = webContents.fromId(senderId);
  const win = contents ? BrowserWindow.fromWebContents(contents) : null;
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    message: translate(
      locale,
      'This file is outside the workspace and was not written by this conversation. Show it anyway?'
    ),
    detail: file,
    buttons: [translate(locale, REVEAL_LABEL), translate(locale, 'Cancel')],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const { response } =
    win && !win.isDestroyed()
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
  return response === 0;
}
