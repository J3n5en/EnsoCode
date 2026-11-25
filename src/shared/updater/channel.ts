/** 更新渠道：stable 只收正式版；beta 收 main 自动构建的内测预发布与正式版中较新的那个 */
export type UpdateChannel = 'stable' | 'beta';

export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = 'stable';

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return value === 'stable' || value === 'beta';
}

export function isPrereleaseVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+-/.test(version);
}

/** 手动更新提示里 npm install 的包规格：内测渠道装 @beta，否则装正式版（@latest） */
export function manualInstallSpec(channel: UpdateChannel): string {
  return `@ensocode/server@${channel === 'beta' ? 'beta' : 'latest'}`;
}

/** 按目标版本本身判断手动安装规格：预发布版本用 beta dist-tag，正式版用 latest */
export function manualInstallSpecForVersion(version: string): string {
  return `@ensocode/server@${isPrereleaseVersion(version) ? 'beta' : 'latest'}`;
}

/**
 * 套到 electron-updater 上。GitHub provider 的取版逻辑：
 * - allowPrerelease=false：GET github.com/<owner>/<repo>/releases/latest（只会是标了 Latest 的正式版），读该 tag 下的 latest*.yml；
 * - allowPrerelease=true：取 releases.atom 第一条（预发布或正式版），预发布 tag 读 beta*.yml（404 退回 latest*.yml），正式版读 latest*.yml。
 * 不设 autoUpdater.channel：它的 setter 会把 allowDowngrade 置 true，且 channel 会让正式版 tag 也去找 beta*.yml。
 * AppUpdater 构造时按当前版本是否预发布给 allowPrerelease 赋默认值，所以两项都要显式写；降级一律关闭。
 */
export function applyUpdateChannel(
  updater: { allowPrerelease: boolean; allowDowngrade: boolean },
  channel: UpdateChannel
): void {
  updater.allowPrerelease = channel === 'beta';
  updater.allowDowngrade = false;
}
