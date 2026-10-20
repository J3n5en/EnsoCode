import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { OpenInApp } from '@shared/types';
import { app } from 'electron';

interface OpenInAppDefinition {
  id: string;
  name: string;
  kind: OpenInApp['kind'];
  /** macOS bundle id，经 Launch Services 解析，覆盖 ~/Applications */
  mac?: string[] | undefined;
  /** Windows 可执行文件名，先查 App Paths 再查 PATH */
  win?: string[] | undefined;
  /** Linux PATH 上的二进制名 */
  linux?: string | undefined;
  /** Windows / Linux 启动参数：含 {path} 时替换，否则把目录追加在末尾 */
  args?: string[] | undefined;
}

type Targets = Pick<OpenInAppDefinition, 'mac' | 'win' | 'linux' | 'args'>;
const editor = (id: string, name: string, targets: Targets): OpenInAppDefinition => ({
  id,
  name,
  kind: 'editor',
  ...targets,
});
const terminal = (id: string, name: string, targets: Targets): OpenInAppDefinition => ({
  id,
  name,
  kind: 'terminal',
  ...targets,
});

const APPS: readonly OpenInAppDefinition[] = [
  editor('vscode', 'VS Code', { mac: ['com.microsoft.VSCode'], win: ['Code.exe'], linux: 'code' }),
  editor('cursor', 'Cursor', {
    mac: ['com.todesktop.230313mzl4w4u92'],
    win: ['Cursor.exe'],
    linux: 'cursor',
  }),
  editor('windsurf', 'Windsurf', {
    mac: ['com.exafunction.windsurf'],
    win: ['Windsurf.exe'],
    linux: 'windsurf',
  }),
  editor('antigravity', 'Antigravity', {
    mac: ['com.google.antigravity'],
    win: ['Antigravity.exe'],
    linux: 'antigravity',
  }),
  editor('zed', 'Zed', { mac: ['dev.zed.Zed'], linux: 'zed' }),
  editor('sublime', 'Sublime Text', {
    mac: ['com.sublimetext.4', 'com.sublimetext.3'],
    win: ['sublime_text.exe'],
    linux: 'subl',
  }),
  editor('intellij', 'IntelliJ IDEA', {
    mac: ['com.jetbrains.intellij', 'com.jetbrains.intellij.ce'],
    win: ['idea64.exe'],
    linux: 'idea',
  }),
  editor('webstorm', 'WebStorm', {
    mac: ['com.jetbrains.WebStorm'],
    win: ['webstorm64.exe'],
    linux: 'webstorm',
  }),
  editor('pycharm', 'PyCharm', {
    mac: ['com.jetbrains.pycharm', 'com.jetbrains.pycharm.ce'],
    win: ['pycharm64.exe'],
    linux: 'pycharm',
  }),
  editor('goland', 'GoLand', {
    mac: ['com.jetbrains.goland'],
    win: ['goland64.exe'],
    linux: 'goland',
  }),
  editor('xcode', 'Xcode', { mac: ['com.apple.dt.Xcode'] }),
  terminal('apple-terminal', 'Terminal', { mac: ['com.apple.Terminal'] }),
  terminal('iterm2', 'iTerm2', { mac: ['com.googlecode.iterm2'] }),
  terminal('warp', 'Warp', { mac: ['dev.warp.Warp-Stable'] }),
  // 终端的位置参数会被当作要执行的命令，必须用工作目录参数；Ghostty 只接受 --flag=value
  terminal('ghostty', 'Ghostty', {
    mac: ['com.mitchellh.ghostty'],
    linux: 'ghostty',
    args: ['--working-directory={path}'],
  }),
  terminal('wezterm', 'WezTerm', {
    mac: ['com.github.wez.wezterm'],
    win: ['wezterm-gui.exe'],
    linux: 'wezterm',
    args: ['start', '--cwd'],
  }),
  terminal('kitty', 'kitty', {
    mac: ['net.kovidgoyal.kitty'],
    linux: 'kitty',
    args: ['--directory'],
  }),
  terminal('alacritty', 'Alacritty', {
    mac: ['org.alacritty'],
    win: ['alacritty.exe'],
    linux: 'alacritty',
    args: ['--working-directory'],
  }),
  terminal('windows-terminal', 'Windows Terminal', { win: ['wt.exe'], args: ['-d'] }),
  terminal('gnome-terminal', 'GNOME Terminal', {
    linux: 'gnome-terminal',
    args: ['--working-directory'],
  }),
  terminal('konsole', 'Konsole', { linux: 'konsole', args: ['--workdir'] }),
];

const PROBE_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 60_000;

// 一次子进程批量解析 bundle id → bundle 路径
const MAC_RESOLVE_SCRIPT = `ObjC.import('AppKit')
function run(argv) {
  const workspace = $.NSWorkspace.sharedWorkspace
  const result = {}
  for (const id of JSON.parse(argv[0])) {
    const url = workspace.URLForApplicationWithBundleIdentifier(id)
    result[id] = url && !url.isNil() ? ObjC.unwrap(url.path) : null
  }
  return JSON.stringify(result)
}`;

interface DetectedApp {
  definition: OpenInAppDefinition;
  /** macOS 为 bundle 路径，其余平台为可执行文件路径 */
  target: string;
  icon?: string;
}

export function buildLaunchArgs(args: readonly string[] | undefined, dir: string): string[] {
  if (!args?.length) return [dir];
  return args.some((arg) => arg.includes('{path}'))
    ? args.map((arg) => arg.replace('{path}', dir))
    : [...args, dir];
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout))
    );
  });
}

function findOnPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  const win = platform === 'win32';
  for (const dir of (env.PATH ?? env.Path ?? '').split(win ? ';' : ':')) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      if (win) {
        if (existsSync(candidate)) return candidate;
      } else {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // 不在此目录
    }
  }
  return null;
}

async function readRegistryDefault(key: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    // 按类型列锚定：`(默认)` 这类值名会被本地化
    const match = (await run('reg', ['query', key, '/ve'])).match(
      /\s{2,}REG_(EXPAND_SZ|SZ)\s{2,}(.+)/i
    );
    const value = match?.[2]?.trim().replace(/^"|"$/g, '');
    if (!value) return null;
    return match?.[1]?.toUpperCase() === 'EXPAND_SZ'
      ? value.replace(/%([^%]+)%/g, (ref, name: string) => env[name] ?? ref)
      : value;
  } catch {
    return null;
  }
}

async function resolveWindowsExe(exe: string, env: NodeJS.ProcessEnv) {
  // 用户级安装（VS Code / Cursor 默认）只能写 HKCU
  for (const root of ['HKCU', 'HKLM']) {
    const resolved = await readRegistryDefault(
      `${root}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
      env
    );
    if (resolved && existsSync(resolved)) return resolved;
  }
  return findOnPath(exe, env, 'win32');
}

/** Electron 的 getFileIcon 对 .app 只返回通用图标，改把 bundle 里的 icns 转成 PNG */
async function macBundleIcon(bundle: string): Promise<string | undefined> {
  const dir = await mkdtemp(path.join(tmpdir(), 'enso-app-icon-'));
  try {
    const plist = path.join(bundle, 'Contents', 'Info.plist');
    const name = (await run('plutil', ['-extract', 'CFBundleIconFile', 'raw', plist])).trim();
    if (!name) return undefined;
    const icns = path.join(
      bundle,
      'Contents',
      'Resources',
      name.endsWith('.icns') ? name : `${name}.icns`
    );
    const out = path.join(dir, 'icon.png');
    await run('sips', ['-z', '64', '64', '-s', 'format', 'png', icns, '--out', out]);
    return `data:image/png;base64,${(await readFile(out)).toString('base64')}`;
  } catch {
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withIcon(entry: DetectedApp, platform: NodeJS.Platform): Promise<DetectedApp> {
  let icon: string | undefined;
  if (platform === 'darwin') icon = await macBundleIcon(entry.target);
  else {
    const image = await app.getFileIcon(entry.target, { size: 'normal' }).catch(() => null);
    icon = image && !image.isEmpty() ? image.toDataURL() : undefined;
  }
  return icon ? { ...entry, icon } : entry;
}

async function detect(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Promise<DetectedApp[]> {
  if (platform === 'darwin') {
    const definitions = APPS.filter((definition) => definition.mac);
    const ids = definitions.flatMap((definition) => definition.mac ?? []);
    const resolved = JSON.parse(
      await run('osascript', ['-l', 'JavaScript', '-e', MAC_RESOLVE_SCRIPT, JSON.stringify(ids)])
    ) as Record<string, string | null>;
    const found = definitions.flatMap((definition): DetectedApp[] => {
      const target = definition.mac?.map((id) => resolved[id]).find(Boolean);
      return target ? [{ definition, target }] : [];
    });
    return Promise.all(found.map((entry) => withIcon(entry, platform)));
  }
  if (platform === 'win32') {
    const found = await Promise.all(
      APPS.filter((definition) => definition.win).map(async (definition) => {
        for (const exe of definition.win ?? []) {
          const target = await resolveWindowsExe(exe, env);
          if (target) return withIcon({ definition, target }, platform);
        }
        return null;
      })
    );
    return found.filter((entry): entry is DetectedApp => entry !== null);
  }
  // Linux 的 getFileIcon 只给通用可执行文件图标，交给渲染层回退
  return APPS.flatMap((definition) => {
    const target = definition.linux && findOnPath(definition.linux, env, platform);
    return target ? [{ definition, target }] : [];
  });
}

function launch(
  platform: NodeJS.Platform,
  detected: DetectedApp,
  dir: string,
  cwd: string
): Promise<void> {
  if (platform === 'darwin') return run('open', ['-a', detected.target, dir]).then(() => undefined);
  return new Promise((resolve, reject) => {
    const child = spawn(detected.target, buildLaunchArgs(detected.definition.args, dir), {
      cwd,
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export function createOpenInApps({
  platform = process.platform,
  env = process.env,
}: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
} = {}) {
  let cache: { at: number; apps: Promise<DetectedApp[]> } | undefined;

  const detected = (): Promise<DetectedApp[]> => {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.apps;
    const apps = detect(platform, env);
    const entry = { at: Date.now(), apps };
    cache = entry;
    // 一次探测失败不能钉死成「没有应用」
    apps.catch(() => {
      if (cache === entry) cache = undefined;
    });
    return apps;
  };

  return {
    async list(): Promise<OpenInApp[]> {
      try {
        return (await detected()).map(({ definition, icon }) => ({
          id: definition.id,
          name: definition.name,
          kind: definition.kind,
          ...(icon ? { icon } : {}),
        }));
      } catch (error) {
        console.warn('[OpenInApps] detect failed:', error);
        return [];
      }
    },
    async open(appId: string, dir: string, cwd = dir): Promise<{ ok: boolean; error?: string }> {
      const target = (await detected().catch(() => [])).find(
        (entry) => entry.definition.id === appId
      );
      if (!target) return { ok: false, error: 'unavailable' };
      try {
        await launch(platform, target, dir, cwd);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'unavailable' };
      }
    },
  };
}

export const openInApps = createOpenInApps();
