import {
  CONTEXT_PART_ITEMS,
  type ContextPart,
  type ContextPartItem,
  type ContextPartKind,
  type ContextUsagePayload,
} from '@shared/extensionPlugins/events';
import {
  estimateInstructionTokens,
  estimateSkillTokens,
  estimateToolTokens,
  type OccupancySkill,
  type OccupancyTool,
} from '@shared/occupancy';

/** 与 magpie 一致：每类最多这么多项，其余合并成一项 */
const PART_ITEMS = CONTEXT_PART_ITEMS;
const PART_ORDER: readonly ContextPartKind[] = [
  'system',
  'tools',
  'skills',
  'memory',
  'files',
  'results',
  'chat',
];

const READ_TOOLS = new Set([
  'read',
  'Read',
  'read_file',
  'ReadFile',
  'view',
  'View',
  'NotebookRead',
  'readFile',
  'open_file',
]);
const PATH_KEYS = ['path', 'file_path', 'filePath', 'target_file', 'notebook_path', 'file'];
const READ_COMMANDS = new Set(['cat', 'head', 'tail', 'nl', 'bat', 'less', 'more']);

/** 只做读文件的 shell 命令读了哪些文件；管道、重定向、多条命令一律不算 */
export function filesOfCommand(raw: string): string[] {
  let cmd = raw.trim();
  for (const pre of ['bash -lc ', 'bash -c ', 'sh -c ', 'zsh -lc ']) {
    if (cmd.startsWith(pre))
      cmd = cmd
        .slice(pre.length)
        .trim()
        .replace(/^["']|["']$/g, '');
  }
  if (/[|;&><`$]/.test(cmd)) {
    const at = cmd.indexOf('&&');
    if (!cmd.startsWith('cd ') || at < 0 || /[|;&><`$]/.test(cmd.slice(at + 2))) return [];
    cmd = cmd.slice(at + 2).trim();
  }
  const words = cmd.split(/\s+/);
  const sed = words[0] === 'sed' && words.includes('-n');
  if (words.length < 2 || (!READ_COMMANDS.has(words[0]) && !sed)) return [];
  const files: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const arg = words[i].replace(/^["']|["']$/g, '');
    if (arg.startsWith('-')) {
      if ((arg === '-n' || arg === '-c') && !sed) i++;
      continue;
    }
    if (sed && /^[\d,$]+p$/.test(arg)) continue;
    if (/^\d+$/.test(arg)) continue;
    if (arg) files.push(arg);
  }
  return files;
}

interface Call {
  name: string;
  files: string[];
}

function callOf(name: string, args: unknown): Call {
  const record = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  if (READ_TOOLS.has(name)) {
    for (const key of PATH_KEYS) {
      const value = record[key];
      if (typeof value === 'string' && value) return { name, files: [value] };
    }
  }
  const command = record.command ?? record.cmd;
  const text = Array.isArray(command) ? command.join(' ') : command;
  return { name, files: typeof text === 'string' ? filesOfCommand(text) : [] };
}

class Builder {
  readonly parts = new Map<ContextPartKind, Map<string, ContextPartItem>>();

  add(kind: ContextPartKind, rawName: string, tag: string, tokens: number): void {
    const name = rawName.slice(0, 1024);
    if (!(tokens > 0)) return;
    let items = this.parts.get(kind);
    if (!items) {
      items = new Map();
      this.parts.set(kind, items);
    }
    const key = `${tag}\0${name}`;
    const item = items.get(key) ?? { name, tag, n: 0, tokens: 0 };
    item.n = (item.n ?? 0) + 1;
    item.tokens += tokens;
    items.set(key, item);
  }

  items(kind: ContextPartKind): ContextPartItem[] {
    return [...(this.parts.get(kind)?.values() ?? [])];
  }
}

/** 按比例把条目缩放到 total，余数给小数部分最大的项，合计严格等于 total */
function scale(items: ContextPartItem[], total: number): void {
  const sum = items.reduce((s, it) => s + it.tokens, 0);
  if (sum <= 0) return;
  const exact = items.map((it) => (it.tokens * total) / sum);
  for (const [i, it] of items.entries()) it.tokens = Math.floor(exact[i]);
  let rest = total - items.reduce((s, it) => s + it.tokens, 0);
  const order = exact
    .map((value, i) => ({ i, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (rest <= 0) break;
    items[i].tokens += 1;
    rest -= 1;
  }
}

function finish(kind: ContextPartKind, raw: ContextPartItem[]): ContextPart | null {
  let items = raw
    .filter((it) => it.tokens > 0)
    .map((it) => {
      const { n, ...rest } = it;
      const counted = (it.tag === 'mcp' || it.tag === 'result') && n !== undefined && n > 1;
      return counted ? { ...rest, n } : rest;
    });
  if (items.length === 0) return null;
  if (kind === 'chat') {
    const summary = items.filter((it) => it.tag === 'compacted');
    const turns = items
      .filter((it) => it.tag !== 'compacted')
      .sort((a, b) => Number(a.name) - Number(b.name));
    const keep = PART_ITEMS - summary.length;
    if (turns.length > keep) {
      const merged = turns.slice(0, turns.length - keep + 1);
      turns.splice(0, merged.length, {
        name: 'earlier',
        tag: 'turns',
        n: merged.length,
        tokens: merged.reduce((s, it) => s + it.tokens, 0),
      });
    }
    items = [...summary, ...turns];
  } else {
    items.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
    if (items.length > PART_ITEMS) {
      const merged = items.splice(PART_ITEMS - 1);
      items.push({
        name: 'other',
        tag: 'more',
        n: merged.length,
        tokens: merged.reduce((s, it) => s + it.tokens, 0),
      });
    }
  }
  return { kind, tokens: items.reduce((s, it) => s + it.tokens, 0), items };
}

function withoutImages(message: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(message.content)) return message;
  return {
    ...message,
    content: message.content.filter(
      (part) => (part as { type?: unknown } | null)?.type !== 'image'
    ),
  };
}

export interface ContextPartsInput {
  /** 最终分桶（已按实报用量校准）；各类条目按它缩放 */
  buckets: ContextUsagePayload['buckets'];
  agentsFiles: ReadonlyArray<{ path: string; content: string }>;
  skills: readonly OccupancySkill[];
  tools: readonly OccupancyTool[];
  reminders: readonly string[];
  messages: readonly unknown[];
  estimate: (message: unknown) => number;
}

/**
 * 按 magpie 的七类拆分上下文：系统、工具、skill、指令记忆、读入的文件、其余工具输出、会话。
 * 分类合计与 buckets 对齐（files + results + chat = conversation + compaction）。
 */
export function buildContextParts(input: ContextPartsInput): {
  parts: ContextPart[];
  turns: number;
} {
  const { buckets } = input;
  const b = new Builder();
  b.add('system', 'system', '', buckets.system);

  for (const tool of input.tools) {
    const ns = /^(mcp__[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*)__/.exec(tool.name)?.[1];
    b.add('tools', ns ?? tool.name, ns ? 'mcp' : '', estimateToolTokens(tool));
  }
  for (const skill of input.skills)
    b.add('skills', skill.name, 'skills', estimateSkillTokens(skill));
  for (const file of input.agentsFiles) {
    b.add('memory', file.path, 'project', estimateInstructionTokens(file.content));
  }

  const calls = new Map<string, Call>();
  let turn = 0;
  const chat = (tokens: number) => b.add('chat', String(Math.max(turn, 1)), 'turn', tokens);
  for (const value of input.messages) {
    if (!value || typeof value !== 'object') continue;
    const message = value as Record<string, unknown>;
    const role = message.role;
    if (role === 'system' || role === 'compactionSummary') continue;
    const total = Math.max(0, input.estimate(message));
    const text = Math.min(total, Math.max(0, input.estimate(withoutImages(message))));
    if (total > text) b.add('files', 'image', 'image', total - text);
    if (role === 'user') {
      turn += 1;
      chat(text);
    } else if (role === 'assistant') {
      if (Array.isArray(message.content)) {
        for (const part of message.content as Array<Record<string, unknown>>) {
          if (part?.type === 'toolCall' && typeof part.id === 'string') {
            calls.set(part.id, callOf(String(part.name ?? ''), part.arguments));
          }
        }
      }
      chat(text);
    } else if (role === 'toolResult') {
      const id = typeof message.toolCallId === 'string' ? message.toolCallId : '';
      const call = calls.get(id) ?? {
        name: typeof message.toolName === 'string' ? message.toolName : 'tool',
        files: [],
      };
      if (call.files.length > 0) {
        const each = Math.floor(text / call.files.length);
        for (const [i, file] of call.files.entries()) {
          const share = i === 0 ? text - each * (call.files.length - 1) : each;
          b.add('files', file, READ_TOOLS.has(call.name) ? 'read' : 'shell', share);
        }
      } else {
        b.add('results', call.name, 'result', text);
      }
    } else {
      chat(text);
    }
  }

  const tools = b.items('tools');
  scale(tools, buckets.tools);
  const skills = b.items('skills');
  scale(skills, buckets.skills);
  const memory = b.items('memory');
  scale(memory, buckets.instructions);
  if (buckets.reminders > 0)
    memory.push({ name: 'reminders', tag: 'reminder', tokens: buckets.reminders });

  const files = b.items('files');
  const results = b.items('results');
  const turns = b.items('chat');
  const conversation = [...files, ...results, ...turns];
  if (conversation.length === 0 && buckets.conversation > 0) {
    turns.push({ name: '1', tag: 'turn', tokens: buckets.conversation });
  } else {
    scale(conversation, buckets.conversation);
  }
  if (buckets.compaction > 0) {
    turns.unshift({ name: 'summary', tag: 'compacted', tokens: buckets.compaction });
  }

  const raw: Record<ContextPartKind, ContextPartItem[]> = {
    system: b.items('system'),
    tools,
    skills,
    memory,
    files,
    results,
    chat: turns,
  };
  const parts = PART_ORDER.map((kind) => finish(kind, raw[kind])).filter(
    (part): part is ContextPart => part !== null
  );
  return { parts, turns: turn };
}
