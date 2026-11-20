import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { applyUpdateChannel, isPrereleaseVersion, type UpdateChannel } from './channel';

// 直接跑 electron-updater 真实的 GitHub provider，只把 HTTP 换成内存里的 Release 列表
const req = createRequire(import.meta.url);
const updaterRequire = createRequire(req.resolve('electron-updater'));
const { GitHubProvider } = updaterRequire('./providers/GitHubProvider');
const { HttpError } = updaterRequire('builder-util-runtime');

const REPO = '/J3n5en/EnsoCode/releases';

interface Release {
  tag: string;
  /** 该 Release 带的更新 yml */
  ymls: string[];
}

function atom(releases: Release[]): string {
  const entries = releases.map(
    ({ tag }) =>
      `<entry><id>tag:github.com,2008:Repository/1/${tag}</id><updated>2026-11-20T00:00:00Z</updated>` +
      `<link rel="alternate" type="text/html" href="https://github.com${REPO}/tag/${tag}"/>` +
      `<title>${tag.slice(1)}</title><content type="html">notes</content></entry>`
  );
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">${entries.join('')}</feed>`;
}

function yml(version: string): string {
  const file = `EnsoCode-${version}-arm64-mac.zip`;
  return `version: ${version}\nfiles:\n  - url: ${file}\n    sha512: x\n    size: 1\npath: ${file}\nsha512: x\nreleaseDate: '2026-11-20T00:00:00.000Z'\n`;
}

/** feed：releases.atom 顺序（新的在前）；latest：/releases/latest 指向的正式版 */
async function resolve(
  channel: UpdateChannel,
  currentVersion: string,
  feed: Release[],
  latest: string
) {
  const requested: string[] = [];
  const executor = {
    request: async (options: { path: string }) => {
      const p = options.path;
      requested.push(p);
      if (p === `${REPO}.atom`) return atom(feed);
      if (p === `${REPO}/latest`) return JSON.stringify({ tag_name: latest });
      const m = /\/download\/([^/]+)\/([^/]+\.yml)$/.exec(p);
      if (m && feed.find((r) => r.tag === m[1])?.ymls.includes(m[2])) return yml(m[1].slice(1));
      throw new HttpError(404, 'Not Found');
    },
  };
  // AppUpdater 构造时 allowPrerelease = 当前版本是否预发布
  const updater = {
    allowPrerelease: isPrereleaseVersion(currentVersion),
    allowDowngrade: false,
    channel: null,
    currentVersion,
    fullChangelog: false,
  };
  applyUpdateChannel(updater, channel);
  const provider = new GitHubProvider(
    { provider: 'github', owner: 'J3n5en', repo: 'EnsoCode' },
    updater,
    { executor, platform: 'darwin', isUseMultipleRangeRequest: false }
  );
  const info = await provider.getLatestVersion();
  return {
    tag: info.tag as string,
    version: info.version as string,
    ymls: requested.filter((p) => p.endsWith('.yml')).map((p) => p.slice(p.indexOf('/download/'))),
    allowDowngrade: updater.allowDowngrade,
  };
}

const STABLE = { tag: 'v0.3.12', ymls: ['latest-mac.yml'] };
const BETA = { tag: 'v0.3.13-beta.7', ymls: ['beta-mac.yml'] };

describe('更新渠道（electron-updater GitHub provider）', () => {
  it('稳定版：feed 最新一条是 beta 也只取标了 Latest 的正式版，读 latest-mac.yml', async () => {
    const result = await resolve('stable', '0.3.11', [BETA, STABLE], 'v0.3.12');
    expect(result).toMatchObject({ tag: 'v0.3.12', version: '0.3.12' });
    expect(result.ymls).toEqual(['/download/v0.3.12/latest-mac.yml']);
  });

  it('稳定版装着 beta 包（切回稳定版）：仍只看正式版，且不允许降级', async () => {
    const result = await resolve('stable', '0.3.13-beta.5', [BETA, STABLE], 'v0.3.12');
    expect(result).toMatchObject({ tag: 'v0.3.12', allowDowngrade: false });
  });

  it('内测版：最新是 beta 时读该预发布的 beta-mac.yml', async () => {
    const result = await resolve('beta', '0.3.12', [BETA, STABLE], 'v0.3.12');
    expect(result).toMatchObject({ tag: 'v0.3.13-beta.7', version: '0.3.13-beta.7' });
    expect(result.ymls).toEqual(['/download/v0.3.13-beta.7/beta-mac.yml']);
  });

  it('内测版：正式版更新时取正式版，读 latest-mac.yml', async () => {
    const stable = { tag: 'v0.3.13', ymls: ['latest-mac.yml'] };
    const result = await resolve('beta', '0.3.13-beta.7', [stable, BETA], 'v0.3.13');
    expect(result).toMatchObject({ tag: 'v0.3.13', version: '0.3.13' });
    expect(result.ymls).toEqual(['/download/v0.3.13/latest-mac.yml']);
  });

  it('内测版也不允许降级', async () => {
    const result = await resolve('beta', '0.3.13-beta.9', [BETA, STABLE], 'v0.3.12');
    expect(result.allowDowngrade).toBe(false);
  });

  it('不碰 autoUpdater.channel（其 setter 会打开降级）', () => {
    const updater = {
      allowPrerelease: true,
      allowDowngrade: true,
      set channel(_value: string) {
        throw new Error('channel must not be set');
      },
    };
    applyUpdateChannel(updater, 'stable');
    expect(updater).toMatchObject({ allowPrerelease: false, allowDowngrade: false });
    applyUpdateChannel(updater, 'beta');
    expect(updater).toMatchObject({ allowPrerelease: true, allowDowngrade: false });
  });

  it('识别预发布版本号', () => {
    expect(isPrereleaseVersion('0.3.13-beta.12')).toBe(true);
    expect(isPrereleaseVersion('0.3.12')).toBe(false);
    expect(isPrereleaseVersion('dev')).toBe(false);
  });
});
