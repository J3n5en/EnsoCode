import path from 'node:path';

export function bundledRtkPath(options: {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  platform: string;
  arch: string;
}): string {
  const filename = options.platform === 'win32' ? 'rtk.exe' : 'rtk';
  return options.packaged
    ? path.join(options.resourcesPath, 'rtk', filename)
    : path.join(
        options.appPath,
        'resources',
        'rtk',
        `${options.platform}-${options.arch}`,
        filename
      );
}
