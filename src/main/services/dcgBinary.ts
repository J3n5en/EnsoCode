import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { app, net } from '@platform';
import type { DcgStatus, DcgUpdateCheck } from '@shared/types/dcg';

export const DCG_VERSION = '0.17.2';

const RELEASE = `https://github.com/Dicklesworthstone/destructive_command_guard/releases/download/v${DCG_VERSION}`;

export const DCG_LATEST_RELEASE_API =
  'https://api.github.com/repos/Dicklesworthstone/destructive_command_guard/releases/latest';

const ASSETS: Record<string, { file: string; sha256: string }> = {
  'darwin-arm64': {
    file: 'dcg-aarch64-apple-darwin.tar.xz',
    sha256: '4c3354600beea99096227b0ff75add73a3a33a7fc0a3de4aa04853502e3e9093',
  },
  'darwin-x64': {
    file: 'dcg-x86_64-apple-darwin.tar.xz',
    sha256: '8ba28fe673041daab8fbad0dfc12d0fc6269b624da97973ea51d24b76576753e',
  },
  'linux-arm64': {
    file: 'dcg-aarch64-unknown-linux-gnu.tar.xz',
    sha256: '1cd59892eb7c9541026979b18d1d64cd4c62f9c923b3eb7cd106f7505fe27620',
  },
  'linux-x64': {
    file: 'dcg-x86_64-unknown-linux-musl.tar.xz',
    sha256: 'c393d4d56b8c481dea38456e4f8829b4bb563c6f6fb541457374ac4be9928db4',
  },
  // Windows ARM 靠系统 x64 模拟运行
  'win32-x64': {
    file: 'dcg-x86_64-pc-windows-msvc.zip',
    sha256: '42a042874ec44f5fe895cd64ea930fd14c50fe0a0ba4a8e02692dfaf36c6218d',
  },
  // 0.17.2 起 Windows ARM 有原生包；sha256 取自上游 release 文件实算复核
  'win32-arm64': {
    file: 'dcg-aarch64-pc-windows-msvc.zip',
    sha256: '84d3672201810d05bbaa4e3988eb2abfccb183de8c2cf204fcda0b620c1c3bae',
  },
};

export interface DcgAsset {
  url: string;
  sha256: string;
  binary: string;
}

export function dcgAsset(platform: string, arch: string): DcgAsset | null {
  const entry = ASSETS[`${platform}-${arch}`];
  if (!entry) return null;
  return {
    url: `${RELEASE}/${entry.file}`,
    sha256: entry.sha256,
    binary: platform === 'win32' ? 'dcg.exe' : 'dcg',
  };
}

const baseDir = (root: string) => path.join(root, 'dcg');

export const dcgRoot = (): string => app.getPath('userData');

const binaryName = (platform: string) => (platform === 'win32' ? 'dcg.exe' : 'dcg');

const STRICT_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * 实际可用的 dcg 二进制：优先内置目标版本；不存在时回退到 userData/dcg 下
 * 最高 semver 版本的旧二进制——升级 EnsoCode 后老用户已装的旧版继续防护，而不是静默失效。
 */
export function resolveInstalledDcg(
  root: string,
  platform: string = process.platform
): { path: string; version: string } | null {
  const base = baseDir(root);
  const binary = binaryName(platform);
  const target = path.join(base, DCG_VERSION, binary);
  if (fs.existsSync(target)) return { path: target, version: DCG_VERSION };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        STRICT_VERSION.test(entry.name) &&
        !entry.name.startsWith('.tmp-') &&
        fs.existsSync(path.join(base, entry.name, binary))
    )
    .map((entry) => entry.name)
    .sort((a, b) => compareDcgVersions(a, b) ?? 0);
  const best = candidates.at(-1);
  return best ? { path: path.join(base, best, binary), version: best } : null;
}

export function installedDcgPath(root: string, platform: string = process.platform): string | null {
  return resolveInstalledDcg(root, platform)?.path ?? null;
}

export function dcgStatus(
  root: string,
  platform: string = process.platform,
  arch: string = process.arch
): DcgStatus {
  const installed = resolveInstalledDcg(root, platform);
  return {
    supported: dcgAsset(platform, arch) !== null,
    installed: installed !== null,
    installedVersion: installed?.version ?? null,
    version: DCG_VERSION,
  };
}

// 系统 tar 自动识别 xz / zip（macOS、Linux、Windows 10+ 均自带）
const systemExtract = async (archive: string, dir: string) => {
  await promisify(execFile)('tar', ['-xf', archive, '-C', dir], { windowsHide: true });
};

export async function installDcg(opts: {
  root: string;
  platform?: string;
  arch?: string;
  asset?: DcgAsset;
  fetch?: (url: string) => Promise<Response>;
  extract?: (archive: string, dir: string) => Promise<void>;
}): Promise<string> {
  const platform = opts.platform ?? process.platform;
  const asset = opts.asset ?? dcgAsset(platform, opts.arch ?? process.arch);
  if (!asset) throw new Error('dcg is unsupported on this platform');
  const base = baseDir(opts.root);
  const tmp = path.join(base, `.tmp-${randomUUID()}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const response = await (opts.fetch ?? ((url: string) => net.fetch(url)))(asset.url);
    if (!response.ok) throw new Error(`dcg download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== asset.sha256) throw new Error('dcg download sha256 mismatch');
    const archive = path.join(tmp, path.basename(new URL(asset.url).pathname));
    fs.writeFileSync(archive, bytes);
    const out = path.join(tmp, 'out');
    fs.mkdirSync(out);
    await (opts.extract ?? systemExtract)(archive, out);
    const extracted = path.join(out, asset.binary);
    if (!fs.existsSync(extracted)) throw new Error(`dcg archive missing ${asset.binary}`);
    fs.chmodSync(extracted, 0o755);
    const dest = path.join(base, DCG_VERSION);
    // 只清理 semver 版本目录；无关目录和文件（notes、杀软隔离残留等）不动
    for (const entry of fs.readdirSync(base)) {
      if (STRICT_VERSION.test(entry))
        fs.rmSync(path.join(base, entry), { recursive: true, force: true });
    }
    fs.mkdirSync(dest);
    const target = path.join(dest, asset.binary);
    fs.renameSync(extracted, target);
    return target;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function uninstallDcg(root: string): Promise<void> {
  await fs.promises.rm(baseDir(root), { recursive: true, force: true });
}

const parseVersion = (value: string) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  return match ? match.slice(1).map(Number) : null;
};

/** 只比较正式版 major.minor.patch；预发布或非法版本返回 null */
export function compareDcgVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

/** 仅由用户点击「检查更新」触发；未认证 GitHub API 每小时 60 次，限流与网络错误分开报告 */
export async function checkDcgUpdate(
  opts: { current?: string; fetch?: (url: string, init: RequestInit) => Promise<Response> } = {}
): Promise<DcgUpdateCheck> {
  const current = opts.current ?? DCG_VERSION;
  const fetchImpl = opts.fetch ?? ((url: string, init: RequestInit) => net.fetch(url, init));
  let response: Response;
  try {
    response = await fetchImpl(DCG_LATEST_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { status: 'failed', current, reason: 'network' };
  }
  if (
    response.status === 429 ||
    (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
  )
    return { status: 'failed', current, reason: 'rate-limited' };
  if (!response.ok) return { status: 'failed', current, reason: 'network' };
  let tag: unknown;
  try {
    tag = ((await response.json()) as { tag_name?: unknown } | null)?.tag_name;
  } catch {
    return { status: 'failed', current, reason: 'invalid' };
  }
  const order = typeof tag === 'string' ? compareDcgVersions(tag, current) : null;
  if (order === null) return { status: 'failed', current, reason: 'invalid' };
  const latest = (tag as string).trim().replace(/^v/, '');
  return { status: order > 0 ? 'available' : 'latest', current, latest };
}
