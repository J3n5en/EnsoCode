import type { SecretaryReportFile, SecretaryReportPull } from '../types/secretary';

/** 汇报里认作截图的扩展名；真正的格式在复制时按文件头判 */
const IMAGE_EXT = '(?:png|jpe?g|webp|gif)';
/** 反引号里的整段路径：允许空格 */
const QUOTED_PATH = new RegExp(`\`((?:file://)?/[^\`\\n]+?\\.${IMAGE_EXT})\``, 'giu');
/** 裸路径：前面是行首、空白或括号引号；// 开头的是网址 */
const BARE_PATH = new RegExp(
  `(?<=^|[\\s(\\[<'"\`：:，,（])((?:file://)?/(?!/)[^\\s\`'"()<>\\[\\]]+?\\.${IMAGE_EXT})(?=$|[\\s\`'")\\]>,;:!?。，；：）】]|\\.(?=\\s|$))`,
  'gimu'
);
const LOCAL_IMAGE_EMBED = /!\[[^\]]*\]\(\s*<?((?:file:\/\/)?\/[^)>\s]+)>?\s*\)/gu;
const PULL_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/u;
const PULL_NUMBER = /(?:\bPR|pull request)\s*#?(\d+)\b/iu;

function localPath(raw: string): string {
  if (!raw.startsWith('file://')) return raw;
  const rest = raw.slice('file://'.length);
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}

/** 汇报里点到的本地截图路径，按出现顺序去重；只认绝对路径，网址不算 */
export function extractReportImagePaths(text: string | undefined): string[] {
  if (!text) return [];
  const hits: { at: number; path: string }[] = [];
  for (const pattern of [QUOTED_PATH, BARE_PATH]) {
    for (const match of text.matchAll(pattern))
      hits.push({ at: match.index ?? 0, path: localPath(match[1] ?? '') });
  }
  hits.sort((a, b) => a.at - b.at);
  return [...new Set(hits.map((hit) => hit.path).filter(Boolean))];
}

/** 汇报里的 PR：先认链接，再认「PR #123」；认不出返回 null，不猜 */
export function extractPullRef(
  text: string | undefined
): { url: string; number: number } | { number: number } | null {
  if (!text) return null;
  const url = PULL_URL.exec(text);
  if (url) return { url: url[0], number: Number(url[1]) };
  const number = PULL_NUMBER.exec(text);
  return number ? { number: Number(number[1]) } : null;
}

function count(raw: string): number | null {
  return /^\d+$/u.test(raw) ? Number(raw) : null;
}

/** 重命名的两种写法都取新路径：a/{old => new}/b 与 old => new */
function renamedPath(raw: string): string {
  const braced = raw.replace(/\{[^{}]* => ([^{}]*)\}/gu, '$1').replace(/\/{2,}/gu, '/');
  const arrow = braced.lastIndexOf(' => ');
  return arrow >= 0 ? braced.slice(arrow + 4) : braced;
}

/** `git diff --numstat` / `git show --numstat` 的输出 */
export function parseNumstat(stdout: string): SecretaryReportFile[] {
  const files: SecretaryReportFile[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/u.exec(line);
    if (!match) continue;
    files.push({
      path: renamedPath(match[3] ?? ''),
      additions: count(match[1] ?? ''),
      deletions: count(match[2] ?? ''),
    });
  }
  return files;
}

const PULL_STATES = new Set(['OPEN', 'MERGED', 'CLOSED']);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** `gh pr view --json number,url,state,mergeCommit,files` 的输出；格式不对返回 null */
export function parsePullView(
  stdout: string
): { pr: SecretaryReportPull; files: SecretaryReportFile[] } | null {
  let data: Record<string, unknown> | null;
  try {
    data = record(JSON.parse(stdout));
  } catch {
    return null;
  }
  if (!data || !Number.isInteger(data.number) || typeof data.url !== 'string') return null;
  const pr: SecretaryReportPull = { number: data.number as number, url: data.url };
  if (typeof data.state === 'string' && PULL_STATES.has(data.state))
    pr.state = data.state as SecretaryReportPull['state'];
  const oid = record(data.mergeCommit)?.oid;
  if (pr.state === 'MERGED' && typeof oid === 'string' && /^[0-9a-f]{7,40}$/u.test(oid))
    pr.mergeSha = oid;
  const files: SecretaryReportFile[] = [];
  for (const entry of Array.isArray(data.files) ? data.files : []) {
    const file = record(entry);
    if (!file || typeof file.path !== 'string') continue;
    files.push({
      path: file.path,
      additions: Number.isInteger(file.additions) ? (file.additions as number) : null,
      deletions: Number.isInteger(file.deletions) ? (file.deletions as number) : null,
    });
  }
  return { pr, files };
}

/** 结果视图里的正文：本地图片的 markdown 嵌入换成文件名，图统一放在下面的缩略图里 */
export function reportTextForView(text: string): string {
  return text.replace(LOCAL_IMAGE_EMBED, (_whole, target: string) => {
    const name = localPath(target).split('/').pop() || target;
    return `\`${name}\``;
  });
}
