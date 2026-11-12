import { join } from 'node:path';

/**
 * Windows 任务栏/Shell 需要多尺寸 .ico（≤128 的 BMP 帧，带 AND 掩码）。
 * 单张 PNG（icon-win.png）在任务栏上会被缩成方形底板。
 * Linux 仍优先使用 PNG 路径。
 */
export const WINDOW_ICON_FILE_WIN = 'icon.ico';
export const WINDOW_ICON_FILE_LINUX = 'icon-win.png';

/** 安装版必须与 electron-builder.yml 的 `appId` 一致。 */
export const WINDOWS_APP_USER_MODEL_ID = 'com.j3n5en.enso-code';

/**
 * 打包后的 Windows 绝不能调用 BrowserWindow.setIcon。
 *
 * Electron nativeImage 只加载 ICO 里最大的一帧并生成单个 HICON，
 * 任务栏随后会画成方形底板。EnsoAI 打包后从不 setIcon——
 * 改由 Shell 读取 EXE 的 RT_GROUP_ICON（多尺寸 BMP + AND 掩码）。
 * 开发环境仍需要 setIcon，因为宿主 exe 是 electron.exe。
 */
export function shouldSetWindowIcon(input: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
}): boolean {
  if (input.platform === 'darwin') return false;
  if (input.platform === 'win32' && input.isPackaged) return false;
  return true;
}

/**
 * win-unpacked / 便携版运行时不能与已安装版共用开始菜单 AUMID。
 *
 * 某个 AppUserModelId 的任务栏图标来自已注册的快捷方式，而不是正在运行的 exe；
 * setAppDetails(appIconPath) 也覆盖不了。使用独立 AUMID 后，
 * Shell 才会使用本进程自己的 RT_GROUP_ICON。
 */
export function resolveWindowsAppUserModelId(input: {
  execPath: string;
  isPackaged: boolean;
}): string {
  if (!input.isPackaged) return `${WINDOWS_APP_USER_MODEL_ID}.dev`;
  const normalized = input.execPath.replace(/\//g, '\\').toLowerCase();
  // electron-builder 的 dir 产物，或 Local\Programs\enso-code 之外的任何副本
  if (normalized.includes('\\win-unpacked\\') || normalized.includes('\\dist\\')) {
    return `${WINDOWS_APP_USER_MODEL_ID}.portable`;
  }
  return WINDOWS_APP_USER_MODEL_ID;
}

/**
 * 把任务栏重启元数据固定到当前运行的 exe（Jump List / 部分 shell 会用到）。
 * AUMID 本身由 resolveWindowsAppUserModelId 决定——正是它修复了测试 win-unpacked 时
 * 沿用已安装快捷方式而显示方形底板的问题。
 */
export function windowsTaskbarAppDetails(input: {
  execPath: string;
  appId: string;
  displayName?: string;
}): {
  appId: string;
  appIconPath: string;
  appIconIndex: number;
  relaunchCommand: string;
  relaunchDisplayName: string;
} {
  const exe = input.execPath;
  const quoted = exe.includes(' ') ? `"${exe}"` : exe;
  return {
    appId: input.appId,
    appIconPath: exe,
    appIconIndex: 0,
    relaunchCommand: quoted,
    relaunchDisplayName: input.displayName ?? 'EnsoCode',
  };
}

/** 先找打包后的 extraResources，再找仓库 build/（供 `electron-vite dev` 使用）。 */
export function windowIconCandidates(input: {
  resourcesPath: string;
  appPath: string;
  cwd: string;
  platform?: NodeJS.Platform;
}): string[] {
  const file =
    (input.platform ?? process.platform) === 'linux'
      ? WINDOW_ICON_FILE_LINUX
      : WINDOW_ICON_FILE_WIN;
  return [
    join(input.resourcesPath, file),
    join(input.cwd, 'build', file),
    join(input.appPath, 'build', file),
  ];
}
