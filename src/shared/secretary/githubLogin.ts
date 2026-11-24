/** GitHub login：字母或数字开头，后面最多 38 个字母、数字或连字符 */
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export const GITHUB_LOGINS_MAX = 10;

/** 落盘解析：坏值丢掉，大小写不敏感去重，保留先出现的写法，最多 10 个 */
export function githubLoginsFrom(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const logins: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const login = item.trim();
    if (!GITHUB_LOGIN.test(login)) continue;
    const key = login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    logins.push(login);
    if (logins.length >= GITHUB_LOGINS_MAX) break;
  }
  return logins;
}

/** 设置入口：有一个非法就整单拒绝。空数组是解绑 */
export function githubLoginsInput(raw: unknown): { ok: true; logins: string[] } | { ok: false } {
  if (!Array.isArray(raw) || raw.length > GITHUB_LOGINS_MAX) return { ok: false };
  const seen = new Set<string>();
  const logins: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false };
    const login = item.trim();
    if (!login) continue;
    if (!GITHUB_LOGIN.test(login)) return { ok: false };
    const key = login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    logins.push(login);
  }
  return { ok: true, logins };
}
