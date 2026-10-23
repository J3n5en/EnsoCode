export type MarkdownLinkKind = 'local' | 'external' | 'blocked';

export type MarkdownLink =
  | { kind: 'local'; path: string }
  | { kind: 'external' }
  | { kind: 'blocked' };

const PROTOCOL_RE = /^[a-z][a-z\d+.-]*:/i;
const SAFE_EXTERNAL_PROTOCOL_RE = /^(?:https?|ircs?|mailto|xmpp):/i;
const WINDOWS_ABSOLUTE_RE = /^(?:[a-z]:[\\/]|\\\\)/i;

/** 拆开 `path:line` / `path:start-end` 形式的文件引用，行号取起始行 */
export function splitFileLineRef(value: string): { path: string; line?: number } {
  const match = /^(.*?):(\d+)(?:-\d+)?$/.exec(value);
  if (!match) return { path: value };
  const line = Number(match[2]);
  return line > 0 ? { path: match[1], line } : { path: match[1] };
}

function decodePath(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function withoutSuffix(value: string): string {
  const suffix = value.search(/[?#]/);
  return suffix < 0 ? value : value.slice(0, suffix);
}

function parseFileUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:') return null;
    let pathname = decodeURIComponent(url.pathname);
    if (!pathname) return null;
    if (url.hostname && url.hostname.toLowerCase() !== 'localhost') {
      pathname = `//${url.hostname}${pathname}`;
    } else if (/^\/[a-z]:[\\/]/i.test(pathname)) {
      pathname = pathname.slice(1);
    }
    return pathname;
  } catch {
    return null;
  }
}

/**
 * 将 Markdown 链接分成网页、本地文件路径和危险/不支持协议。
 *
 * Classify a Markdown URL as an external page, a local path, or a dangerous/unsupported protocol.
 */
export function classifyMarkdownLink(raw: string): MarkdownLink {
  const value = raw.trim();
  if (!value || value.startsWith('#') || value.startsWith('?')) return { kind: 'external' };

  if (/^file:/i.test(value)) {
    const path = parseFileUrl(value);
    return path ? { kind: 'local', path } : { kind: 'blocked' };
  }

  if (SAFE_EXTERNAL_PROTOCOL_RE.test(value) || value.startsWith('//')) {
    return { kind: 'external' };
  }

  const decoded = decodePath(withoutSuffix(value));
  if (decoded == null || decoded.includes('\0')) return { kind: 'blocked' };
  if (PROTOCOL_RE.test(decoded) && !WINDOWS_ABSOLUTE_RE.test(decoded)) {
    return { kind: 'blocked' };
  }
  return { kind: 'local', path: decoded };
}

interface CanonicalAbsolutePath {
  value: string;
  windows: boolean;
}

function canonicalAbsolutePath(raw: string): CanonicalAbsolutePath | null {
  const value = raw.replace(/\\/g, '/');
  const windows = /^[a-z]:\//i.test(value) || value.startsWith('//');
  if (!windows && !value.startsWith('/')) return null;

  const drive = /^[a-z]:\//i.test(value) ? value.slice(0, 2).toLowerCase() : null;
  const body = drive ? value.slice(2) : windows ? value.slice(2) : value.slice(1);
  const parts = body.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) return null;
      stack.pop();
    } else {
      stack.push(part);
    }
  }

  if (drive) return { value: `${drive}/${stack.join('/')}`.replace(/\/$/, ''), windows: true };
  if (windows) return { value: `//${stack.join('/')}`, windows: true };
  return { value: `/${stack.join('/')}`.replace(/\/$/, '') || '/', windows: false };
}

function normalizeRelativePath(raw: string): string | null {
  const value = raw.replace(/\\/g, '/');
  const stack: string[] = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) return null;
      stack.pop();
    } else {
      if (part.includes('\0')) return null;
      stack.push(part);
    }
  }
  return stack.join('/');
}

/**
 * 把链接路径转换成可交给 Main 的工作区相对标识；越界或根不匹配返回 null。
 *
 * Convert a link path into the workspace-relative identifier accepted by Main; return null for escapes or root mismatches.
 */
export function toWorkspaceRelativePath(raw: string, cwd?: string): string | null {
  if (!cwd) {
    return canonicalAbsolutePath(raw) ? null : normalizeRelativePath(raw);
  }
  const root = canonicalAbsolutePath(cwd);
  if (!root) return null;

  // Windows 链接可能带 URL 风格的前导斜杠；仅按 Windows 工作区解释，保留 Unix 路径语义。
  //
  // Windows links may include a URL-style leading slash; interpret it only for Windows workspaces to preserve Unix path semantics.
  const targetPath = root.windows && /^\/[a-z]:[\\/]/i.test(raw) ? raw.slice(1) : raw;
  const target = canonicalAbsolutePath(targetPath);
  if (!target) return targetPath === raw ? normalizeRelativePath(raw) : null;
  if (target.windows !== root.windows) return null;

  const comparisonRoot = root.value.toLowerCase();
  const comparisonTarget = target.value.toLowerCase();
  if (comparisonTarget === comparisonRoot) return '';
  const prefix = root.value.endsWith('/') ? root.value : `${root.value}/`;
  if (!comparisonTarget.startsWith(prefix.toLowerCase())) return null;
  return normalizeRelativePath(target.value.slice(prefix.length));
}
