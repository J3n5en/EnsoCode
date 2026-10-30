/** open(1) 认的是 .app 文件名或 bundle id，不是「系统设置」这种本地化显示名。 */
const GROUPS: Array<{ names: readonly string[]; bundle?: string; launch?: string }> = [
  {
    names: ['系统设置', '系统偏好设置', 'system settings', 'system preferences'],
    bundle: 'com.apple.systempreferences',
  },
  { names: ['访达', 'finder'], bundle: 'com.apple.finder' },
  { names: ['活动监视器', 'activity monitor'], bundle: 'com.apple.ActivityMonitor' },
  { names: ['文本编辑', 'textedit', 'text edit'], bundle: 'com.apple.TextEdit' },
  { names: ['微信', 'wechat', 'weixin'], launch: 'WeChat' },
];

export function resolveOpenArgs(name: string, opts?: { pane?: string }): string[] {
  if (opts?.pane !== undefined) {
    const url = resolveSettingsPaneUrl(opts.pane);
    if (!url) throw new Error(`Unsupported System Settings pane: ${opts.pane}`);
    return [url];
  }
  const key = name.trim().toLocaleLowerCase();
  if (!key) return ['-a', name];
  for (const group of GROUPS) {
    if (!group.names.some((item) => item.toLocaleLowerCase() === key)) continue;
    if (group.bundle) return ['-b', group.bundle];
    if (group.launch) return ['-a', group.launch];
  }
  return ['-a', name.trim()];
}

/** 打开应用/面板但不激活：用户的前台与焦点不变，后续操作走后台投递 */
export function backgroundOpenArgs(name: string, opts?: { pane?: string }): string[] {
  return ['-g', ...resolveOpenArgs(name, opts)];
}

export function appLaunchAliases(): Record<string, readonly string[]> {
  const map: Record<string, string[]> = {};
  for (const group of GROUPS) {
    for (const name of group.names) {
      map[name.toLocaleLowerCase()] = group.names.filter(
        (item) => item.toLocaleLowerCase() !== name.toLocaleLowerCase()
      );
    }
  }
  return map;
}

const SETTINGS_PANES: Record<string, string> = {
  外观: 'x-apple.systempreferences:com.apple.Appearance-Settings.extension',
  appearance: 'x-apple.systempreferences:com.apple.Appearance-Settings.extension',
  锁屏: 'x-apple.systempreferences:com.apple.Lock-Screen-Settings.extension',
  'lock screen': 'x-apple.systempreferences:com.apple.Lock-Screen-Settings.extension',
  lockscreen: 'x-apple.systempreferences:com.apple.Lock-Screen-Settings.extension',
  电池: 'x-apple.systempreferences:com.apple.Battery-Settings.extension',
  battery: 'x-apple.systempreferences:com.apple.Battery-Settings.extension',
  显示: 'x-apple.systempreferences:com.apple.Displays-Settings.extension',
  显示器: 'x-apple.systempreferences:com.apple.Displays-Settings.extension',
  displays: 'x-apple.systempreferences:com.apple.Displays-Settings.extension',
  通用: 'x-apple.systempreferences:com.apple.LocalSettings.extension',
  general: 'x-apple.systempreferences:com.apple.LocalSettings.extension',
};

export function resolveSettingsPaneUrl(pane: string): string | undefined {
  const key = pane.trim().toLocaleLowerCase();
  return key ? (SETTINGS_PANES[key] ?? SETTINGS_PANES[pane.trim()]) : undefined;
}
