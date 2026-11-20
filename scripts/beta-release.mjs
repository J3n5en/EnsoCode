#!/usr/bin/env node
// 内测渠道发版辅助（.github/workflows/beta.yml 调用）：
//   node scripts/beta-release.mjs version <run_number>   → 打印 <下一个 patch>-beta.<run_number>
//   node scripts/beta-release.mjs prune <keep> < releases → 打印要删除的旧 beta tag，每行一个
// releases 为 GitHub releases 对象（JSON 数组或每行一个 JSON），至少含 tag_name / prerelease / draft。
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const STABLE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const BETA_TAG = /^v(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/;

/** 大于当前正式版、小于下一个正式版 */
export function betaVersion(packageVersion, runNumber) {
  const m = STABLE_VERSION.exec(String(packageVersion));
  if (!m) throw new Error(`package.json version is not X.Y.Z: ${packageVersion}`);
  if (!/^[1-9]\d*$/.test(String(runNumber))) {
    throw new Error(`run number must be a positive integer: ${runNumber}`);
  }
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}-beta.${runNumber}`;
}

/** 只认已发布的 `vX.Y.Z-beta.N` 预发布；按版本从新到旧保留 keep 个，其余返回 */
export function betaTagsToPrune(releases, keep) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`keep must be >= 1: ${keep}`);
  return releases
    .filter(
      (r) =>
        r?.prerelease === true &&
        r.draft === false &&
        typeof r.tag_name === 'string' &&
        BETA_TAG.test(r.tag_name)
    )
    .map((r) => ({ tag: r.tag_name, parts: BETA_TAG.exec(r.tag_name).slice(1).map(Number) }))
    .sort((a, b) => {
      for (let i = 0; i < 4; i++) if (a.parts[i] !== b.parts[i]) return b.parts[i] - a.parts[i];
      return 0;
    })
    .slice(keep)
    .map((r) => r.tag);
}

export function parseReleases(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) return JSON.parse(trimmed);
  return trimmed
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function main([command, arg]) {
  if (command === 'version') {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    return betaVersion(pkg.version, arg);
  }
  if (command === 'prune') {
    return betaTagsToPrune(parseReleases(readFileSync(0, 'utf8')), Number(arg)).join('\n');
  }
  throw new Error('usage: beta-release.mjs version <run_number> | prune <keep>');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = main(process.argv.slice(2));
  if (out) console.log(out);
}
