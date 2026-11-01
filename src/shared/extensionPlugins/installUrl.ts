const MAX_URL_LENGTH = 2048;

export type PluginInstallUrlResult = { ok: true; url: URL } | { ok: false; error: string };

/** 安装来源只接受没有账号密码的 http(s) 链接 */
export function parsePluginInstallUrl(input: string): PluginInstallUrlResult {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, error: '链接不合法' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: '只支持 http 或 https 链接' };
  }
  if (url.username || url.password) return { ok: false, error: '链接不能带账号密码' };
  if (!url.hostname || url.href.length > MAX_URL_LENGTH) {
    return { ok: false, error: '链接不合法' };
  }
  return { ok: true, url };
}

const GITHUB_HINT =
  'GitHub 仓库请用 https://github.com/owner/repo ，指定目录用 .../tree/分支/子目录；zip 链接可直接粘贴';
const GITHUB_NAME = /^[A-Za-z0-9._-]+$/;

export type PluginArchiveSource =
  | { ok: true; archive: URL; subdir: string | null }
  | { ok: false; error: string };

function githubName(segment: string): boolean {
  return GITHUB_NAME.test(segment) && segment !== '.' && !segment.includes('..');
}

type GithubRepo = { owner: string; repo: string; ref: string | null; subdir: string[] };

/** GitHub 仓库页面拆成仓库/分支/子目录；非 GitHub 或 .zip 链接返回 null，形状不对返回 'invalid' */
function parseGithubRepo(url: URL): GithubRepo | null | 'invalid' {
  const host = url.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') return null;
  if (url.pathname.toLowerCase().endsWith('.zip')) return null;
  let parts: string[];
  try {
    parts = url.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return 'invalid';
  }
  if (parts[1]?.toLowerCase().endsWith('.git')) parts[1] = parts[1].slice(0, -4);
  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo || !githubName(owner) || !githubName(repo)) return 'invalid';
  if (parts.length === 2) return { owner, repo, ref: null, subdir: [] };
  const ref = parts[3];
  const subdir = parts.slice(4);
  if (parts[2] !== 'tree' || !ref || !githubName(ref) || !subdir.every(githubName))
    return 'invalid';
  return { owner, repo, ref, subdir };
}

/** GitHub 仓库页面改写成 zipball；其它链接仍当作 zip。分支名不能含斜杠 */
export function resolvePluginArchive(url: URL): PluginArchiveSource {
  const github = parseGithubRepo(url);
  if (github === 'invalid') return { ok: false, error: GITHUB_HINT };
  if (!github) return { ok: true, archive: url, subdir: null };
  const { owner, repo, ref, subdir } = github;
  const archive = new URL(
    ref
      ? `https://api.github.com/repos/${owner}/${repo}/zipball/${encodeURIComponent(ref)}`
      : `https://api.github.com/repos/${owner}/${repo}/zipball`
  );
  return { ok: true, archive, subdir: subdir.length > 0 ? subdir.join('/') : null };
}

/** 检查更新用：只拉清单原文而不是整包；只支持 GitHub 仓库链接 */
export function pluginManifestProbeUrl(url: URL): URL | null {
  const github = parseGithubRepo(url);
  if (!github || github === 'invalid') return null;
  const path = [
    github.owner,
    github.repo,
    github.ref ?? 'HEAD',
    ...github.subdir,
    'enso-plugin.json',
  ]
    .map(encodeURIComponent)
    .join('/');
  return new URL(`https://raw.githubusercontent.com/${path}`);
}
