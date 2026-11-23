import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { app, net } from '@platform';
import type { DcgStatus, DcgUpdateCheck } from '@shared/types/dcg';

export const DCG_VERSION = '0.16.0';

const RELEASE = `https://github.com/Dicklesworthstone/destructive_command_guard/releases/download/v${DCG_VERSION}`;

export const DCG_LATEST_RELEASE_API =
  'https://api.github.com/repos/Dicklesworthstone/destructive_command_guard/releases/latest';

const ASSETS: Record<string, { file: string; sha256: string }> = {
  'darwin-arm64': {
    file: 'dcg-aarch64-apple-darwin.tar.xz',
    sha256: '06cd609b19b988d267ebfac3e6736e511ba42c7a1746f4ec2af5295a8b300fe0',
  },
  'darwin-x64': {
    file: 'dcg-x86_64-apple-darwin.tar.xz',
    sha256: 'f567c5fe4b3b5dbdf56c1621e5f80d7a8b4463de1cf70eb91b9b99955a623f63',
  },
  'linux-arm64': {
    file: 'dcg-aarch64-unknown-linux-gnu.tar.xz',
    sha256: 'ca4f2c4fee3aea774fac3e53a6a4cab1c7f9c6228f4bd9d6941de05fd5ac6308',
  },
  'linux-x64': {
    file: 'dcg-x86_64-unknown-linux-musl.tar.xz',
    sha256: 'e7d860eba7f99cb5d5535b00942196aae3d6ca22ec049491d74c97aab556b642',
  },
  // Windows ARM 靠系统 x64 模拟运行
  'win32-x64': {
    file: 'dcg-x86_64-pc-windows-msvc.zip',
    sha256: '9b219ec37fedd73b2a1b6bb1bc3303bae991c12f2dd489b7ab15bb1b89a3822b',
  },
};
ASSETS['win32-arm64'] = ASSETS['win32-x64'];

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

function binaryPath(root: string, platform: string): string {
  return path.join(baseDir(root), DCG_VERSION, platform === 'win32' ? 'dcg.exe' : 'dcg');
}

export function installedDcgPath(root: string, platform: string = process.platform): string | null {
  const file = binaryPath(root, platform);
  return fs.existsSync(file) ? file : null;
}

export function dcgStatus(
  root: string,
  platform: string = process.platform,
  arch: string = process.arch
): DcgStatus {
  return {
    supported: dcgAsset(platform, arch) !== null,
    installed: installedDcgPath(root, platform) !== null,
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
    for (const entry of fs.readdirSync(base)) {
      if (!entry.startsWith('.tmp-'))
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
