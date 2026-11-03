/** electron-updater 的 releaseNotes（GitHub 为 HTML 字符串，fullChangelog 时为数组）收窄成单个可渲染字符串 */
export function normalizeReleaseNotes(notes: unknown): string | undefined {
  if (typeof notes === 'string') return notes.trim() || undefined;
  if (!Array.isArray(notes)) return undefined;
  const parts: string[] = [];
  for (const item of notes) {
    if (!item || typeof item !== 'object') continue;
    const { version, note } = item as { version?: unknown; note?: unknown };
    if (typeof version !== 'string' || typeof note !== 'string' || !note.trim()) continue;
    parts.push(`## ${version}\n\n${note.trim()}`);
  }
  return parts.length ? parts.join('\n\n') : undefined;
}
