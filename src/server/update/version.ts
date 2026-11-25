/** 服务端以 npm 包分发；更新检查读 registry 的 latest dist-tag */
export const NPM_PACKAGE = '@ensocode/server';
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function comparePre(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i];
    const y = right[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : Number.NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : Number.NaN;
    const diff = Number.isNaN(nx) || Number.isNaN(ny) ? x.localeCompare(y) : Math.sign(nx - ny);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function isReleaseVersion(value: unknown): value is string {
  return typeof value === 'string' && SEMVER.test(value.trim());
}

/** 无法解析的版本视为相等：不把 dev/垃圾标签当成新版本 */
export function compareVersions(a: string, b: string): number {
  const x = SEMVER.exec(a.trim());
  const y = SEMVER.exec(b.trim());
  if (!x || !y) return 0;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(x[i]) - Number(y[i]);
    if (diff !== 0) return Math.sign(diff);
  }
  return comparePre(x[4], y[4]);
}

export function npmLatestUrl(registry: string, name: string): string {
  return `${registry.replace(/\/+$/, '')}/${name.replace('/', '%2f')}/latest`;
}

/** 任意 dist-tag 的版本地址：beta 渠道查 beta，stable 渠道查 latest，互不干扰 */
export function npmDistTagUrl(registry: string, name: string, tag: string): string {
  return `${registry.replace(/\/+$/, '')}/${name.replace('/', '%2f')}/${encodeURIComponent(tag)}`;
}
export function parseNpmLatest(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const version = (payload as { version?: unknown }).version;
  return isReleaseVersion(version) ? version.trim() : null;
}
