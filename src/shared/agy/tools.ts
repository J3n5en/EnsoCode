const EXACT: Record<string, string> = {
  client_view_file: 'read_file',
  view_file: 'read_file',
  client_list_dir: 'list_dir',
  client_search: 'grep_search',
  client_find: 'find_by_name',
};

const TITLE_NAME = /^(?:Running|Run) ([A-Za-z0-9_]+)\??$/;

export function projectToolName(raw: string): string {
  if (EXACT[raw]) return EXACT[raw];
  if (raw.startsWith('client_')) return raw.slice('client_'.length);
  return raw;
}

export function toolNameFromUpdate(update: { title?: string; rawInput?: unknown }): string {
  const raw = update.rawInput;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    for (const key of ['name', 'tool_name', 'toolName']) {
      if (typeof record[key] === 'string' && record[key]) return projectToolName(record[key]);
    }
  }
  const titled = update.title ? TITLE_NAME.exec(update.title.trim()) : undefined;
  if (titled?.[1]) return projectToolName(titled[1]);
  return projectToolName(update.title?.trim() || 'tool');
}
