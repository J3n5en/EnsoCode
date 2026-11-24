#!/usr/bin/env node
// 内测渠道发版辅助（.github/workflows/beta.yml 调用）：
//   node scripts/beta-release.mjs version <run_number>        → 打印 <下一个 patch>-beta.<N>
//   node scripts/beta-release.mjs superseded <ver> < releases → 同基线已有不小于它的 beta 时打印那个 tag
//   node scripts/beta-release.mjs prune <keep> < releases     → 打印要删除的旧 beta tag，每行一个
// releases 为 GitHub releases 对象（JSON 数组或每行一个 JSON），至少含 tag_name / prerelease / draft。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const STABLE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const BETA_TAG = /^v(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/;
// 0.3.15 这一轮切换前已按 run_number 发到 beta.19x，降回小号会让已装用户收不到更新
const RUN_NUMBER_BASE = '0.3.15';
const POSITIVE_INT = /^[1-9]\d*$/;

/** N 为 HEAD 相对正式版 tag 的 first-parent 提交数：同一提交恒定，后续提交递增，新正式版后从 1 起 */
function betaVersion(packageVersion, commitsSinceStable, runNumber) {
  const m = STABLE_VERSION.exec(String(packageVersion));
  if (!m) throw new Error(`package.json version is not X.Y.Z: ${packageVersion}`);
  const base = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
  const n = base === RUN_NUMBER_BASE ? runNumber : commitsSinceStable;
  if (!POSITIVE_INT.test(String(n)))
    throw new Error(`beta number must be a positive integer: ${n}`);
  return `${base}-beta.${n}`;
}

const betaParts = (tag) => BETA_TAG.exec(tag)?.slice(1).map(Number);

const publishedBetas = (releases) =>
  releases.filter(
    (r) =>
      r?.prerelease === true &&
      r.draft === false &&
      typeof r.tag_name === 'string' &&
      BETA_TAG.test(r.tag_name)
  );

/** 重跑或乱序的旧提交不能再发：返回同基线里编号不小于 version 的已发布 beta tag */
export function supersedingBeta(releases, version) {
  const want = betaParts(`v${version}`);
  if (!want) throw new Error(`not a beta version: ${version}`);
  const hit = publishedBetas(releases).find((r) => {
    const p = betaParts(r.tag_name);
    return p[0] === want[0] && p[1] === want[1] && p[2] === want[2] && p[3] >= want[3];
  });
  return hit?.tag_name ?? null;
}

/** 只认已发布的 `vX.Y.Z-beta.N` 预发布；按版本从新到旧保留 keep 个，其余返回 */
export function betaTagsToPrune(releases, keep) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`keep must be >= 1: ${keep}`);
  return publishedBetas(releases)
    .map((r) => ({ tag: r.tag_name, parts: betaParts(r.tag_name) }))
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
    const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
    const commits = execFileSync(
      'git',
      ['rev-list', '--count', '--first-parent', `v${version}..HEAD`],
      { encoding: 'utf8' }
    ).trim();
    return betaVersion(version, commits, arg);
  }
  if (command === 'superseded') {
    return supersedingBeta(parseReleases(readFileSync(0, 'utf8')), arg) ?? '';
  }
  if (command === 'prune') {
    return betaTagsToPrune(parseReleases(readFileSync(0, 'utf8')), Number(arg)).join('\n');
  }
  throw new Error(
    'usage: beta-release.mjs version <run_number> | superseded <version> | prune <keep>'
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = main(process.argv.slice(2));
  if (out) console.log(out);
}
