import type { ComputerAppIdentity } from '@shared/computer/types';
import { app, dialog } from 'electron';
import type { AppPromptAnswer } from './appAuthorization';

/**
 * 首次操作某个 app 时由用户确认；勾选「始终允许」才落入名单。
 * 必须挂在窗口上：macOS 无父窗口的消息框同步运行，会卡住整个 Main，也无法被 signal 关闭。
 */
export async function promptComputerAppAccess(
  target: ComputerAppIdentity,
  signal: AbortSignal
): Promise<AppPromptAnswer> {
  const zh = app.getLocale().toLowerCase().startsWith('zh');
  const name = app.getName() || 'EnsoCode';
  const options = {
    type: 'question' as const,
    message: zh
      ? `允许 ${name} 操作「${target.name}」？`
      : `Allow ${name} to control “${target.name}”?`,
    detail: zh
      ? `AI 将能在后台点击、输入，并读取「${target.name}」窗口里的全部内容（包括其中他人的消息）。\n${target.path}`
      : `The AI will be able to click and type in the background and read everything in “${target.name}” windows, including other people's messages.\n${target.path}`,
    buttons: zh ? ['允许', '拒绝'] : ['Allow', 'Deny'],
    defaultId: 1,
    cancelId: 1,
    checkboxLabel: zh
      ? '始终允许此应用（可在 设置 → 工具 → Computer 中撤销）'
      : 'Always allow this app (revoke in Settings → Tools → Computer)',
    checkboxChecked: false,
    signal,
  };
  // 按需加载：主窗口模块牵连更新器等，computer 宿主加载时不该带上它们
  const { focusMainWindow, getMainWindow } = await import('../../windows/MainWindow');
  const current = getMainWindow();
  const parent =
    current && !current.isDestroyed() && current.isVisible() && !current.isMinimized()
      ? current
      : focusMainWindow();
  const result = await dialog.showMessageBox(parent, options);
  if (signal.aborted) return 'dismissed';
  if (result.response !== 0) return 'deny';
  return result.checkboxChecked ? 'always' : 'once';
}
