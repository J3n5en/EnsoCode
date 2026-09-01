/** 把 OSC 窗口标题 / cwd 收成短 tab 名(目录末段或进程名) */

export function tabTitleFromTerminal(raw: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 剥 OSC 标题里的控制字符
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!s) return '';
  let path = s;
  const hostSep = s.lastIndexOf(': ');
  if (hostSep >= 0) path = s.slice(hostSep + 2).trim();
  if (!path.includes('/') && !path.startsWith('~')) return path;
  const parts = path.replace(/^~\/?/, '').split('/').filter(Boolean);
  return parts.at(-1) || path;
}
