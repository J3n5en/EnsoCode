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

/** 卡片参数只留可读字段。MCP 名 `mcp_<server>_<tool>` 原样保留。 */
export function cardArgs(name: string, rawInput: unknown): Record<string, unknown> {
  const raw =
    rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : {};
  if (name === 'run_command' || name === 'bash') {
    return pick(raw, { command: ['CommandLine', 'command'] });
  }
  if (name === 'write_file') return pick(raw, { path: ['Path', 'path'], content: ['Content'] });
  if (name === 'edit_file') {
    return pick(raw, {
      path: ['Path', 'path'],
      oldText: ['Target'],
      newText: ['Replacement'],
    });
  }
  if (name === 'search_web') return pick(raw, { query: ['query'] });
  if (name === 'read' || name === 'read_file') {
    return pick(raw, {
      path: ['Path', 'absolute_path', 'path'],
      startLine: ['StartLine'],
      endLine: ['EndLine'],
    });
  }
  return raw;
}

function pick(
  raw: Record<string, unknown>,
  fields: Record<string, readonly string[]>
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, sources] of Object.entries(fields)) {
    for (const source of sources) {
      if (raw[source] !== undefined) {
        args[key] = raw[source];
        break;
      }
    }
  }
  return args;
}

export function toolNameFromUpdate(update: {
  name?: string;
  title?: string;
  rawInput?: unknown;
}): string {
  // agy 1.5.x 在 update 上直接给工具名；title 是给人看的摘要
  if (update.name) return projectToolName(update.name);
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
