// 验收实例用的 Electron 可执行文件。macOS 上换成 Info.plist 带 LSUIElement 的 APFS 克隆：
// 进程一启动就是 UIElement，Dock 不出图标、不会被激活。app 里的 setActivationPolicy
// 赶不上 ESM 主入口加载（实测先当 ~1.4s 前台应用），只能在 bundle 层解决。
//
// 克隆按内容哈希（Info.plist + Framework 本体 + 可执行文件）复用：同一个 Electron 版本无论在哪个
// worktree、rebuild 多少次，都算出同一个 key 只复制一份。每次调用顺手回收：
// 超过 MAX_AGE 且没有任何活进程占用的副本会被删掉。占用靠 .claims/<key>.<pid>
// 认领文件加 lsof 兜底判断，pid 文件即使进程被杀留下垃圾也不影响——liveness 按 pid 查。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_AGE_MS = 72 * 3600 * 1000;
const KEY_RE = /^[0-9a-f]{12}$/;

function bundleKey(bundle, electronPath) {
  const hash = createHash('sha1');
  for (const file of [
    path.join(bundle, 'Contents', 'Info.plist'),
    path.join(
      bundle,
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Electron Framework'
    ),
  ]) {
    try {
      hash.update(readFileSync(file));
    } catch {
      // 精简版 bundle 没有 Framework 时退回可执行文件本体
    }
  }
  hash.update(readFileSync(electronPath));
  return hash.digest('hex').slice(0, 12);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function lsofUses(exe) {
  try {
    return (
      execFileSync('lsof', ['-t', '--', exe], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim().length > 0
    );
  } catch (error) {
    // lsof 以 1 退出表示无占用；其它失败（命令不存在等）保守按占用处理，宁可不删
    return error.status !== 1;
  }
}

function isInUse(dir, exe) {
  const claims = path.join(path.dirname(dir), '.claims');
  const key = path.basename(dir);
  try {
    for (const entry of readdirSync(claims)) {
      if (!entry.startsWith(`${key}.`)) continue;
      const pid = Number(entry.slice(key.length + 1));
      if (Number.isInteger(pid) && pidAlive(pid)) return true;
    }
  } catch {}
  return existsSync(exe) && lsofUses(exe);
}

function safeCopyDir(cacheRoot, name) {
  if (!KEY_RE.test(name)) return undefined;
  const root = path.resolve(cacheRoot);
  const dir = path.resolve(root, name);
  if (path.dirname(dir) !== root) return undefined;
  return dir;
}

/** 回收 cacheRoot 下超龄且无人占用的副本。任何失败都不允许影响验收本身。 */
export function sweepVerifyElectronCache(
  cacheRoot,
  { maxAgeMs = MAX_AGE_MS, now = Date.now() } = {}
) {
  let entries;
  try {
    entries = readdirSync(cacheRoot, { withFileTypes: true });
  } catch {
    return;
  }
  // 残留 staging：进程死在中途留下的半成品，超过一小时直接清
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.includes('.tmp-')) continue;
    try {
      if (now - statSync(path.join(cacheRoot, entry.name)).mtimeMs > 3600 * 1000) {
        rmSync(path.join(cacheRoot, entry.name), { recursive: true, force: true });
      }
    } catch {}
  }
  for (const entry of entries) {
    // entry.isDirectory() 是 lstat 语义：symlink 不算目录，绝不顺着它删到 cacheRoot 之外
    if (!entry.isDirectory()) continue;
    const dir = safeCopyDir(cacheRoot, entry.name);
    if (!dir) continue;
    try {
      const lastuse = path.join(dir, '.lastuse');
      const mtime = existsSync(lastuse) ? statSync(lastuse).mtimeMs : statSync(dir).mtimeMs;
      if (now - mtime < maxAgeMs) continue;
      const exe = path.join(dir, 'Electron.app', 'Contents', 'MacOS', 'Electron');
      if (isInUse(dir, exe)) continue;
      // 先改名再删：改名后若有进程刚好写入新的认领文件，说明它又活过来了，放回去
      const pending = `${dir}.sweep-${process.pid}`;
      renameSync(dir, pending);
      if (isInUse(pending, path.join(pending, 'Electron.app', 'Contents', 'MacOS', 'Electron'))) {
        try {
          renameSync(pending, dir);
        } catch {}
        continue;
      }
      rmSync(pending, { recursive: true, force: true });
    } catch {}
  }
}

function claimCopy(cacheRoot, key) {
  const claims = path.join(cacheRoot, '.claims');
  mkdirSync(claims, { recursive: true });
  closeSync(openSync(path.join(claims, `${key}.${process.pid}`), 'a'));
  // 顺手清掉死进程的认领文件，避免目录无限膨胀
  try {
    for (const entry of readdirSync(claims)) {
      const pid = Number(entry.slice(entry.lastIndexOf('.') + 1));
      if (Number.isInteger(pid) && !pidAlive(pid)) {
        rmSync(path.join(claims, entry), { force: true });
      }
    }
  } catch {}
}

export function uiElementElectron(
  electronPath,
  { platform = process.platform, cacheRoot = path.join(os.tmpdir(), 'enso-verify-electron') } = {}
) {
  const marker = `.app${path.sep}Contents${path.sep}MacOS${path.sep}`;
  const at = electronPath.lastIndexOf(marker);
  if (platform !== 'darwin' || at === -1) return electronPath;
  mkdirSync(cacheRoot, { recursive: true });
  sweepVerifyElectronCache(cacheRoot);
  const bundle = electronPath.slice(0, at + '.app'.length);
  const key = bundleKey(realpathSync(bundle), electronPath);
  const target = path.join(cacheRoot, key, path.basename(bundle));
  const exe = path.join(target, path.relative(bundle, electronPath));
  if (existsSync(exe)) {
    // 先认领再复查：sweep 只删无人认领的副本，复查挡住所剩无几的改名竞态
    claimCopy(cacheRoot, key);
    if (existsSync(exe)) {
      try {
        const now = new Date();
        utimesSync(path.join(cacheRoot, key, '.lastuse'), now, now);
      } catch {
        closeSync(openSync(path.join(cacheRoot, key, '.lastuse'), 'a'));
      }
      return exe;
    }
    rmSync(path.join(cacheRoot, '.claims', `${key}.${process.pid}`), { force: true });
  }

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
  closeSync(openSync(path.join(staging, '.lastuse'), 'a'));
  try {
    // 目标目录可能只剩认领检查后留下的空壳，先清掉再原子换入
    if (existsSync(path.dirname(target)) && !existsSync(exe)) {
      rmSync(path.dirname(target), { recursive: true, force: true });
    }
    renameSync(staging, path.dirname(target));
  } catch (error) {
    // 并发的另一次验收先建好了同一份克隆
    if (!existsSync(exe)) throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  claimCopy(cacheRoot, key);
  return exe;
}
