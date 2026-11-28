import { describe, expect, it } from 'vitest';
import {
  agyHostTools,
  ENSO_TOOL_CALL,
  ENSO_TOOL_SEARCH,
  type ExposableTool,
  type HostMcpToolEntry,
  hostMcpToolBytes,
  isEnsoMcpCardName,
  lazyCallOf,
  mcpContent,
  searchLazyTools,
} from './hostTools';

/** 一个 tools/list 条目恰好 `bytes` 字节的工具 */
function sized(name: string, bytes: number): ExposableTool {
  const base = { name, description: '', parameters: { type: 'object', properties: {} } };
  const [entry] = agyHostTools([{ ...base, name: 'todo' }], Infinity).eager;
  const over = bytes - hostMcpToolBytes({ ...entry!, name });
  if (over < 0) throw new Error(`${name} cannot be ${bytes} bytes`);
  return { ...base, description: 'x'.repeat(over) };
}

const names = (tools: readonly { name: string }[]) => tools.map((tool) => tool.name);
const total = (tools: readonly HostMcpToolEntry[]) =>
  tools.reduce((sum, tool) => sum + hostMcpToolBytes(tool), 0);
const META = [ENSO_TOOL_SEARCH, ENSO_TOOL_CALL];

describe('host MCP tool selection', () => {
  it('exposes only the Enso tools agy lacks, with plain descriptions and copied schemas', () => {
    const schema = { type: 'object', properties: { question: { type: 'string' } } };
    const { eager, lazy } = agyHostTools([
      { name: 'read', description: 'Read a file' },
      { name: 'bash', description: 'Run a command' },
      { name: 'web_fetch', description: 'Fetch' },
      { name: 'codemode', description: 'Run JS' },
      { name: 'ask_user', description: 'Ask the user.', parameters: schema },
      { name: 'ask_user', description: 'duplicate' },
      { name: 'subagent', description: 'Delegate.' },
      { name: 'mcp__github__list', description: 'List issues' },
    ]);
    expect(names(eager)).toEqual(['subagent', 'ask_user', ...META]);
    expect(names(lazy)).toEqual(['mcp__github__list']);
    expect(eager[1]).toEqual({
      name: 'ask_user',
      description: 'Ask the user.',
      inputSchema: schema,
    });
    expect(eager[1]?.inputSchema).not.toBe(schema);
    expect(eager[0]?.inputSchema).toEqual({ type: 'object' });
  });

  it('drops tools that only act on pi context, which agy does not use', () => {
    const { eager, lazy } = agyHostTools(
      ['recall', 'turn_discard', 'turn_recall', 'todo'].map((name) => ({ name }))
    );
    expect(names(eager)).toEqual(['todo']);
    expect(lazy).toEqual([]);
  });

  it('adds no meta tools when nothing is lazy, and never takes a session tool of their name', () => {
    expect(names(agyHostTools([{ name: 'todo' }]).eager)).toEqual(['todo']);
    const { eager, lazy } = agyHostTools([
      { name: ENSO_TOOL_CALL, description: 'impostor' },
      { name: 'tg_send_message' },
    ]);
    expect(names(lazy)).toEqual(['tg_send_message']);
    expect(eager.find((tool) => tool.name === ENSO_TOOL_CALL)?.description).not.toBe('impostor');
  });

  it('measures the exact UTF-8 tools/list entry', () => {
    const [tool] = agyHostTools([{ name: 'todo', description: '记一下', parameters: {} }]).eager;
    expect(tool).toEqual({ name: 'todo', description: '记一下', inputSchema: { type: 'object' } });
    expect(hostMcpToolBytes(tool!)).toBe(new TextEncoder().encode(JSON.stringify(tool)).byteLength);
    expect(hostMcpToolBytes(tool!)).toBe(JSON.stringify(tool).length + 6);
  });

  it('keeps only the core eager, in priority order, and puts everything else behind search', () => {
    const { eager, lazy } = agyHostTools([
      { name: 'mcp__github__list' },
      { name: 'tg_send_message' },
      { name: 'browser_click' },
      { name: 'memory_search' },
      { name: 'reminder_list' },
      { name: 'goal_complete' },
      { name: 'computer' },
      { name: 'image_view' },
      { name: 'ImageGen' },
      { name: 'todo' },
      { name: 'remind_me' },
      { name: 'ask_user' },
      { name: 'workflow' },
      { name: 'subagent' },
      { name: 'github_list' },
    ]);
    expect(names(eager)).toEqual([
      'subagent',
      'workflow',
      'ask_user',
      'todo',
      'goal_complete',
      'remind_me',
      'reminder_list',
      'memory_search',
      'image_view',
      'computer',
      ...META,
    ]);
    expect(names(lazy)).toEqual([
      'mcp__github__list',
      'tg_send_message',
      'browser_click',
      'ImageGen',
      'github_list',
    ]);
  });

  it("lists the secretary's frequent ops directly so it does not search for them first", () => {
    const { eager, lazy } = agyHostTools(
      [
        'session_create',
        'session_list',
        'session_read',
        'session_send',
        'session_archive',
        'cleanup_list',
        'cleanup_apply',
        'result_mark_done',
        'trigger_create',
        'silence_turn',
        'memory_search',
        'ask_user',
      ].map((name) => ({ name }))
    );
    expect(names(eager)).toEqual([
      'ask_user',
      'silence_turn',
      'cleanup_apply',
      'cleanup_list',
      'session_list',
      'session_archive',
      'session_read',
      'result_mark_done',
      'memory_search',
      ...META,
    ]);
    expect(names(lazy)).toEqual(['session_create', 'session_send', 'trigger_create']);
  });

  it('moves a core tool that does not fit the budget to the lazy set instead of dropping it', () => {
    const { eager, lazy } = agyHostTools(
      [sized('subagent', 600), sized('workflow', 2000), sized('todo', 300), sized('tg_a', 100)],
      600 + 300 + total(agyHostTools([{ name: 'tg_x' }]).eager)
    );
    expect(names(eager)).toEqual(['subagent', 'todo', ...META]);
    expect(names(lazy)).toEqual(['workflow', 'tg_a']);
    expect(agyHostTools([], 1000)).toEqual({ eager: [], lazy: [] });
    // 预算连元工具都放不下：什么都不挂
    expect(agyHostTools([sized('todo', 300)], 0).eager).toEqual([]);
  });

  it('is deterministic for the same input', () => {
    const input = [sized('tg_a', 500), sized('subagent', 900), sized('memory_search', 700)];
    expect(agyHostTools([...input])).toEqual(agyHostTools(input));
  });
});

describe('lazy Enso tools', () => {
  const lazy = agyHostTools([
    {
      name: 'tg_send_message',
      description: 'Send a text message as the user’s own Telegram account.\nOnly when asked.',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
    },
    { name: 'github_list', description: 'List GitHub issues or pull requests.' },
    { name: 'cron_create', description: 'x'.repeat(400) },
  ]).lazy;

  it('lists names with one-line descriptions without a query', () => {
    const text = searchLazyTools(lazy, undefined);
    expect(text).toContain(
      '- tg_send_message: Send a text message as the user’s own Telegram account. Only when asked.'
    );
    expect(text).toContain('- github_list: List GitHub issues or pull requests.');
    expect(text.split('\n').find((line) => line.startsWith('- cron_create'))?.length).toBeLessThan(
      170
    );
    expect(searchLazyTools(lazy, '   ')).toBe(text);
    expect(searchLazyTools(lazy, 42)).toBe(text);
    expect(searchLazyTools([], undefined)).toMatch(/No other EnsoCode tools/);
  });

  it('returns full definitions for matching tools, exact names first, any casing', () => {
    const found = JSON.parse(searchLazyTools(lazy, 'TELEGRAM')) as HostMcpToolEntry[];
    expect(found).toEqual([lazy[0]]);
    const exact = JSON.parse(searchLazyTools(lazy, 'list github_list')) as HostMcpToolEntry[];
    expect(names(exact)).toEqual(['github_list']);
    expect(searchLazyTools(lazy, 'kanban')).toMatch(/No EnsoCode tool matches "kanban"/);
  });

  it('normalizes enso_tool_call arguments before the tool validates them', () => {
    expect(lazyCallOf({ name: ' tg_send_message ', arguments: { text: 'hi' } })).toEqual({
      name: 'tg_send_message',
      arguments: { text: 'hi' },
    });
    expect(lazyCallOf({ name: 'github_list' })).toEqual({ name: 'github_list', arguments: {} });
    expect(lazyCallOf({ name: 'github_list', arguments: '{"state":"open"}' })).toEqual({
      name: 'github_list',
      arguments: { state: 'open' },
    });
    expect(lazyCallOf({ name: 'github_list', arguments: '' })).toEqual({
      name: 'github_list',
      arguments: {},
    });
    for (const bad of [{}, { name: '' }, { name: 3 }])
      expect(lazyCallOf(bad)).toHaveProperty('error');
    for (const args of ['[1]', 'nope', [1], 5]) {
      expect(lazyCallOf({ name: 'github_list', arguments: args })).toHaveProperty('error');
    }
  });
});

describe('host MCP content', () => {
  it('passes text and image blocks through and drops the rest', () => {
    expect(
      mcpContent([
        { type: 'text', text: 'hi' },
        { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
        { type: 'image', data: 'BBBB' },
        { type: 'toolCall', id: 'x' },
        null,
      ])
    ).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
      { type: 'image', data: 'BBBB', mimeType: 'image/png' },
    ]);
    expect(mcpContent(undefined)).toEqual([]);
  });

  it('recognises the agy-side card of our own MCP tools only', () => {
    expect(isEnsoMcpCardName('mcp_enso_ask_user')).toBe(true);
    expect(isEnsoMcpCardName('mcp_enso_enso_tool_call')).toBe(true);
    expect(isEnsoMcpCardName('mcp_github_list')).toBe(false);
    expect(isEnsoMcpCardName('read_file')).toBe(false);
  });
});
