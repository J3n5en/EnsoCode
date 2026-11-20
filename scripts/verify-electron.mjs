// 验收实例用的 Electron 可执行文件。macOS 上换成 Info.plist 带 LSUIElement 的 APFS 克隆：
// 进程一启动就是 UIElement，Dock 不出图标、不会被激活。app 里的 setActivationPolicy
// 赶不上 ESM 主入口加载（实测先当 ~1.4s 前台应用），只能在 bundle 层解决。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function uiElementElectron(
  electronPath,
  { platform = process.platform, cacheRoot = path.join(os.tmpdir(), 'enso-verify-electron') } = {}
) {
  const marker = `.app${path.sep}Contents${path.sep}MacOS${path.sep}`;
  const at = electronPath.lastIndexOf(marker);
  if (platform !== 'darwin' || at === -1) return electronPath;
  const bundle = electronPath.slice(0, at + '.app'.length);
  const key = createHash('sha1')
    .update(`${realpathSync(bundle)}\0${statSync(electronPath).mtimeMs}`)
    .digest('hex')
    .slice(0, 12);
  const target = path.join(cacheRoot, key, path.basename(bundle));
  const exe = path.join(target, path.relative(bundle, electronPath));
  if (existsSync(exe)) return exe;

  const staging = path.join(cacheRoot, `${key}.tmp-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const copy = path.join(staging, path.basename(bundle));
  try {
    execFileSync('cp', ['-cR', bundle, copy], { stdio: 'ignore' });
  } catch {
    rmSync(copy, { recursive: true, force: true });
    execFileSync('cp', ['-R', bundle, copy], { stdio: 'ignore' });
  }
  execFileSync('plutil', [
    '-replace',
    'LSUIElement',
    '-bool',
    'YES',
    path.join(copy, 'Contents', 'Info.plist'),
  ]);
  try {
    renameSync(staging, path.dirname(target));
  } catch (error) {
    // 并发的另一次验收先建好了同一份克隆
    if (!existsSync(exe)) throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return exe;
}
