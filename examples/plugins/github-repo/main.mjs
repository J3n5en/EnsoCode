const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const HEADERS = { accept: 'application/vnd.github+json', 'user-agent': 'enso-plugin-example' };

async function getJson(enso, url) {
  const res = await enso.net.fetch(url, { headers: HEADERS });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`GitHub 返回 ${res.status}`);
  return JSON.parse(res.body);
}

/** @param {import('../../../types/enso-plugin').EnsoMain} enso */
export function activate(enso) {
  enso.tools.register('repo_info', async (args) => {
    const repo = String(args.repo ?? '').trim();
    if (!REPO.test(repo)) throw new Error('repo 需要是 owner/name 格式');
    const info = await getJson(enso, `https://api.github.com/repos/${repo}`);
    if (!info) return `Repository ${repo} not found (or private).`;
    const release = await getJson(
      enso,
      `https://api.github.com/repos/${repo}/releases/latest`
    ).catch(() => null);
    const lines = [
      `${info.full_name}: ${info.description ?? '(no description)'}`,
      `stars ${info.stargazers_count}, forks ${info.forks_count}, open issues ${info.open_issues_count}`,
      `default branch ${info.default_branch}, license ${info.license?.spdx_id ?? 'none'}`,
      release
        ? `latest release ${release.tag_name} (${release.published_at?.slice(0, 10)})`
        : 'no releases',
      info.html_url,
    ];
    if (args.notify) {
      await enso.ui.notify(info.full_name, `★ ${info.stargazers_count}`).catch(() => {});
    }
    return { content: lines.join('\n'), details: { stars: info.stargazers_count } };
  });
}
