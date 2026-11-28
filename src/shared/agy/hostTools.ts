/**
 * agy 自带读写、命令、搜索、联网工具；Enso 只把它没有的工具挂到 Host MCP 上。
 * codemode / tool_search / 后台任务 / 探后折叠是 Enso 自己 harness 的工具，对 agy 没有意义。
 * recall / turn_discard / turn_recall 只作用于 pi 的上下文（连续记忆的压缩观察、本轮出入上下文），
 * agy 自己持有对话上下文，pi 那份上下文不进 agy，调了也改变不了 agy 看到的东西。
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
  'recall',
  'turn_discard',
  'turn_recall',
]);

/**
 * agy 对 ACP 注入的 MCP 工具有一个声明预算：只启用放得下的那部分，其余既不直调也不能经
 * call_mcp_tool 转调（报 `tool <x> is not enabled for server enso`）。ACP 注入的服务器没有原生懒加载
 * （agy 的 tools.eager / force_all_tools_eager 只在它自己的 mcp_config.json 里），所以 Enso 只把核心
 * 工具直接挂出去，其余走 enso_tool_search / enso_tool_call。这里的预算只是核心工具的安全网。
 * agy 1.5.18 实测（tools/list 条目 JSON 字节）：
 * - 21 个工具、36,907 B 全部启用，再加一个 1,837 B 的就不启用（Gemini 默认模型）；
 * - 45 个工具、39,839 B 启用，两个 6 KB 的被挤掉（Gemini 4 Hydrogen）；
 * - 43 个工具、39,047 B 启用，篇幅在参数 description 里也照算（Claude Sonnet 4.6）；
 * - 预算在服务器间共享：enso 占满时，第二个 ACP 注入的 30 KB 服务器 0 个启用，用户 agy 配置里的
 *   browse 也不能直调；server 上的额外字段、工具 `_meta` 提示都换不来懒加载。
 * 等大的工具里挑谁看不出规律，大工具先被挤掉。看着是按 token 或篇幅计、不按字节精确卡；
 * 取 30,000 B，比实测下限低约 19%，并给用户自己配置的 MCP 服务器留点余地。
 */
export const AGY_HOST_MCP_BUDGET_BYTES = 30_000;

/**
 * 秘书最常用、篇幅又小的 op。懒加载时每个都得先 enso_tool_search 查 schema：多一次 agy 安全预审（MCP 工具
 * 不在 agy_tool_safety 白名单里），再多一次带全量上下文的主模型请求。本机 2 天 agy 秘书会话实测：
 * silence_turn 70 次、cleanup_apply/list 65 次、session_list/archive/read 49 次、result_mark_done 6 次，
 * 55 次 enso_tool_search 里 49 次出在秘书会话。这几个直挂共约 8.6 KB。
 * session_create（4.7 KB）、session_send（3.5 KB）篇幅大，每轮都带的成本不一定抵得过省下的查询，仍走懒加载。
 */
const SECRETARY_HOT = [
  'silence_turn',
  'cleanup_apply',
  'cleanup_list',
  'session_list',
  'session_archive',
  'session_read',
  'result_mark_done',
];

/**
 * agy 直接看到的 Enso 核心工具，越靠前越优先，同一档按会话工具表原顺序。
 * 其余（插件、接管的 MCP、内置浏览器、ImageGen…）都走懒加载：只挂 enso_tool_search / enso_tool_call，
 * agy 先查再调。agy 1.5.18 对 ACP 注入的服务器一律 eager，不给原生懒加载（见 PR 说明）。
 */
const CORE: ReadonlyArray<string | RegExp> = [
  'subagent',
  'workflow',
  'ask_user',
  ...SECRETARY_HOT,
  'todo',
  /^goal_/,
  'remind_me',
  /^reminder_/,
  /^memory_/,
  'image_view',
  'computer',
];

export const ENSO_TOOL_SEARCH = 'enso_tool_search';
export const ENSO_TOOL_CALL = 'enso_tool_call';
const META_TOOLS = new Set([ENSO_TOOL_SEARCH, ENSO_TOOL_CALL]);

function coreRank(name: string): number {
  return CORE.findIndex((entry) => (typeof entry === 'string' ? entry === name : entry.test(name)));
}

export interface ExposableTool {
  name: string;
  description?: string;
  parameters?: unknown;
}

export interface HostMcpToolEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AgyHostToolSet {
  /** tools/list 里的工具：核心工具，有懒加载工具时再加两个元工具。顺序就是 tools/list 顺序 */
  eager: HostMcpToolEntry[];
  /** 经 enso_tool_search / enso_tool_call 才够得着的工具 */
  lazy: HostMcpToolEntry[];
}

export function exposedToAgy(name: string): boolean {
  return !NOT_EXPOSED.has(name) && !META_TOOLS.has(name);
}

const encoder = new TextEncoder();

/** 这个工具在 tools/list 响应里占多少字节（UTF-8） */
export function hostMcpToolBytes(tool: HostMcpToolEntry): number {
  return encoder.encode(JSON.stringify(tool)).byteLength;
}

const META_ENTRIES: HostMcpToolEntry[] = [
  {
    name: ENSO_TOOL_SEARCH,
    description:
      'Find EnsoCode tools that are not listed directly: plugin tools (chat apps, GitHub, scheduling, swarms…) and MCP servers EnsoCode connects to. Without a query, lists every such tool with a one-line description. With a query (words, or an exact tool name), returns the matching tools with their full input schema. Then call one with enso_tool_call.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Words to match against tool names and descriptions, or an exact tool name',
        },
      },
    },
  },
  {
    name: ENSO_TOOL_CALL,
    description:
      "Call an EnsoCode tool found with enso_tool_search. Pass its exact name, and its arguments as an object matching that tool's input schema.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact tool name from enso_tool_search' },
        arguments: { type: 'object', description: 'Arguments for that tool' },
      },
      required: ['name'],
    },
  },
];

/**
 * 分出 agy 直接看到的核心工具和懒加载的其余工具。工具描述原样给，不加任何「你运行在…」之类的说明。
 * 预算是安全网：核心工具按优先级放进预算（先给两个元工具留位），放不下的转懒加载，不会凭空消失。
 */
export function agyHostTools(
  tools: readonly ExposableTool[],
  budget = AGY_HOST_MCP_BUDGET_BYTES
): AgyHostToolSet {
  const seen = new Set<string>();
  const candidates: HostMcpToolEntry[] = [];
  for (const tool of tools) {
    if (!tool?.name || !exposedToAgy(tool.name) || seen.has(tool.name)) continue;
    seen.add(tool.name);
    const schema =
      tool.parameters && typeof tool.parameters === 'object' && !Array.isArray(tool.parameters)
        ? (JSON.parse(JSON.stringify(tool.parameters)) as Record<string, unknown>)
        : {};
    candidates.push({
      name: tool.name,
      description: tool.description ?? '',
      // 和 hostMcp 的 tools/list 同形，量出来的就是发出去的
      inputSchema: { type: 'object', ...schema },
    });
  }
  const core = candidates
    .map((tool, index) => ({ tool, index, rank: coreRank(tool.name) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.tool);
  const meta = META_ENTRIES.reduce((sum, tool) => sum + hostMcpToolBytes(tool), 0);
  const eager: HostMcpToolEntry[] = [];
  let used = meta;
  for (const tool of core) {
    const size = hostMcpToolBytes(tool);
    if (used + size > budget) continue;
    used += size;
    eager.push(tool);
  }
  const lazy = candidates.filter((tool) => !eager.includes(tool));
  if (lazy.length > 0 && meta <= budget) {
    eager.push(...META_ENTRIES.map((tool) => structuredClone(tool)));
  }
  return { eager, lazy };
}

const ONE_LINE = 140;
const SEARCH_LIMIT = 10;

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= ONE_LINE ? line : `${line.slice(0, ONE_LINE - 1)}…`;
}

/** enso_tool_search 的结果文字：无 query 列名字 + 一行描述；有 query 给匹配工具的完整定义 */
export function searchLazyTools(lazy: readonly HostMcpToolEntry[], query: unknown): string {
  const text = typeof query === 'string' ? query.trim() : '';
  if (!text) {
    if (lazy.length === 0) return 'No other EnsoCode tools are available.';
    return [
      `${lazy.length} EnsoCode tools. Search a name or words to get the input schema, then call it with ${ENSO_TOOL_CALL}.`,
      ...lazy.map((tool) => `- ${tool.name}: ${oneLine(tool.description)}`),
    ].join('\n');
  }
  const needle = text.toLowerCase();
  const words = needle.split(/[\s,]+/).filter(Boolean);
  const scored = lazy
    .map((tool, index) => {
      const name = tool.name.toLowerCase();
      const description = tool.description.toLowerCase();
      let score = name === needle || words.includes(name) ? 100 : 0;
      for (const word of words) {
        if (name.includes(word)) score += 3;
        else if (description.includes(word)) score += 1;
      }
      return { tool, index, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, SEARCH_LIMIT)
    .map((entry) => entry.tool);
  if (scored.length === 0) {
    return `No EnsoCode tool matches "${text}". Call ${ENSO_TOOL_SEARCH} without a query to list them all.`;
  }
  return JSON.stringify(scored, null, 1);
}

/**
 * enso_tool_call 的参数：`{ name, arguments }`。arguments 缺省为 `{}`；模型把它写成 JSON 字符串时先解开，
 * 在工具自己的参数校验之前归一化。
 */
export function lazyCallOf(
  args: Record<string, unknown>
): { name: string; arguments: Record<string, unknown> } | { error: string } {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) return { error: `${ENSO_TOOL_CALL} needs the exact tool name in "name".` };
  let value: unknown = args.arguments ?? {};
  if (typeof value === 'string') {
    try {
      value = value.trim() ? JSON.parse(value) : {};
    } catch {
      return { error: `"arguments" for ${name} must be a JSON object.` };
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: `"arguments" for ${name} must be a JSON object.` };
  }
  return { name, arguments: value as Record<string, unknown> };
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

const PROXIED_TITLE = /^MCP Tool (?<tool>[A-Za-z0-9_-]+)\??$/;

/**
 * agy 经 `call_mcp_tool` 转调的我们自己的工具（同 t3 AntigravityAcpSupport）：title `MCP Tool <tool>`，
 * rawInput 写明 `ServerName` 和同名 `ToolName`。只有这一种调用的 rawInput 指名服务器和工具；
 * 直调工具的 rawInput 是它自己的参数，叫什么都不算。返回工具名，不是则 undefined。
 */
export function ensoProxiedTool(
  call: { name?: string; title?: string; rawInput?: unknown },
  server = 'enso'
): string | undefined {
  if (call.name !== undefined && call.name !== 'call_mcp_tool') return undefined;
  const tool = PROXIED_TITLE.exec(call.title?.trim() ?? '')?.groups?.tool;
  if (!tool) return undefined;
  const raw =
    call.rawInput && typeof call.rawInput === 'object' && !Array.isArray(call.rawInput)
      ? (call.rawInput as Record<string, unknown>)
      : undefined;
  if (!raw || typeof raw.CommandLine === 'string') return undefined;
  return raw.ServerName === server && raw.ToolName === tool ? tool : undefined;
}
