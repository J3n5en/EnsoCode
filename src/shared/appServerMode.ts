import path from 'node:path';

/** 关光窗口后进程是否继续活着：服务端模式或 macOS 默认都留着。 */
export function shouldStayAliveOnWindowAllClosed(input: {
  serverMode: boolean;
  platform: NodeJS.Platform;
}): boolean {
  return input.serverMode || input.platform === 'darwin';
}

export type TrayClickAction = 'show' | 'hide';

/** 托盘左键：窗口实际可见时进托盘；已在托盘或窗口被别处藏起时唤回。 */
export function trayClickAction(input: {
  serverMode: boolean;
  windowShown: boolean;
}): TrayClickAction {
  return !input.serverMode && input.windowShown ? 'hide' : 'show';
}

const TRAY_ICON_RELATIVE = [
  path.join('build', 'icons', '32x32.png'),
  path.join('build', 'icons', '16x16.png'),
  path.join('build', 'icon.png'),
];

const TRAY_TEMPLATE_FILE = 'trayTemplate.png';
const TRAY_TEMPLATE_RELATIVE = path.join('build', TRAY_TEMPLATE_FILE);

export function isTrayTemplatePath(file: string): boolean {
  return path.basename(file).startsWith('trayTemplate');
}

/** 1×1 黑像素，找不到文件时也能画出可见托盘。 */
export const FALLBACK_TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M+AHwAFhgJ/lT5hGAAAAABJRU5ErkJggg==';

export function trayIconCandidates(input: {
  appPath: string;
  resourcesPath: string;
  moduleDir: string;
  cwd: string;
  platform?: NodeJS.Platform;
}): string[] {
  const roots = [
    path.join(input.resourcesPath),
    path.join(input.moduleDir, '..', '..'),
    input.cwd,
    input.appPath,
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (file: string) => {
    const normalized = path.normalize(file);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };
  push(path.join(input.resourcesPath, TRAY_TEMPLATE_FILE));
  for (const root of roots) {
    push(path.join(root, TRAY_TEMPLATE_RELATIVE));
  }
  if (input.platform !== 'darwin') {
    push(path.join(input.resourcesPath, 'tray-icon.png'));
    for (const root of roots) {
      for (const relative of TRAY_ICON_RELATIVE) push(path.join(root, relative));
    }
  }
  return out;
}

export function firstExistingPath(
  candidates: string[],
  exists: (file: string) => boolean
): string | null {
  return candidates.find(exists) ?? null;
}
