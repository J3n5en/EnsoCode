/**
 * agy 自带读写、命令、搜索、联网工具；Enso 只把它没有的工具挂到 Host MCP 上。
 * codemode / tool_search / 后台任务 / 探后折叠是 Enso 自己 harness 的工具，对 agy 没有意义。
 */
const NOT_EXPOSED = new Set([
  'read',
  'write',
  'edit',
  'apply_patch',
  'bash',
  'grep',
  'find',
  'ls',
  'web_search',
  'web_search_exa',
  'web_fetch',
  'codemode',
  'tool_search',
  'task_output',
  'task_stop',
  'task_settle',
  'explore_mark',
  'explore_fold',
]);

export interface ExposableTool {
  name: string;
  description?: string;
  parameters?: unknown;
}

export function exposedToAgy(name: string): boolean {
  return !NOT_EXPOSED.has(name);
}

/** 工具描述原样给，不加任何「你运行在…」之类的说明。 */
export function hostMcpTools(tools: readonly ExposableTool[]): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const seen = new Set<string>();
  const out = [];
  for (const tool of tools) {
    if (!tool?.name || !exposedToAgy(tool.name) || seen.has(tool.name)) continue;
    seen.add(tool.name);
    const schema =
      tool.parameters && typeof tool.parameters === 'object' && !Array.isArray(tool.parameters)
        ? (JSON.parse(JSON.stringify(tool.parameters)) as Record<string, unknown>)
        : {};
    out.push({ name: tool.name, description: tool.description ?? '', inputSchema: schema });
  }
  return out;
}

/** pi 工具结果 → MCP content：文字和图片照传，其余块丢掉。 */
export function mcpContent(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const row = block as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
    if (row.type === 'text' && typeof row.text === 'string') {
      out.push({ type: 'text', text: row.text });
    } else if (row.type === 'image' && typeof row.data === 'string') {
      out.push({
        type: 'image',
        data: row.data,
        mimeType: typeof row.mimeType === 'string' ? row.mimeType : 'image/png',
      });
    }
  }
  return out;
}

/** agy 给我们自己 MCP 工具的卡片名：`mcp_enso_<tool>`。Enso 自己画卡，这张丢掉。 */
export function isEnsoMcpCardName(name: string, server = 'enso'): boolean {
  return name.startsWith(`mcp_${server}_`);
}
