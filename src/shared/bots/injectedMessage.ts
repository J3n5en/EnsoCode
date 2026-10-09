import { splitChatReferences } from './composerRefs';
import { stripBotNotesUpdate } from './notes';

type GroupMessages = { from: string; text: string }[];

type LeadMessage =
  | { kind: 'routine'; title: string; prompt: string; dryRun?: true }
  | { kind: 'delegation-task'; from: string; task: string; context: string }
  | { kind: 'delegation-result'; from: string; status: string; text: string }
  | { kind: 'delegation-results'; results: { from: string; status: string; text: string }[] }
  /** 委派在原子会话上续跑：中途失败接着做（可带委派人说明）/ 验收没过补原因 */
  | { kind: 'delegation-retry'; text: string }
  | { kind: 'delegation-check-failed'; text: string };

/** group：群聊里委派结果 / 例行任务后面补上的、该成员还没看过的群消息；note 为分派提示，refs 为附带的 @聊天 */
export type BotInjectedMessage =
  | {
      kind: 'group';
      messages: GroupMessages;
      instruction: string;
      note?: string;
      refs?: { id: string; title: string }[];
    }
  | (LeadMessage & { group?: GroupMessages });

const entities: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};
const decode = (text: string) =>
  text.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => entities[entity]);

function attributes(text: string): Record<string, string> | null {
  const result: Record<string, string> = Object.create(null);
  const rest = text.replace(/\s+([\w-]+)="([^"]*)"/g, (_, key: string, value: string) => {
    result[key] = decode(value);
    return '';
  });
  return rest.trim() ? null : result;
}

/** 只识别 Main 的整段注入协议；不是通用 XML，正文始终作为文本渲染。 */
export function parseBotInjectedMessage(text: string): BotInjectedMessage | null {
  const source = stripBotNotesUpdate(text).trim();
  const whole = parseSource(source);
  if (whole || source.startsWith('<group') || source.startsWith('（')) return whole;
  for (const split of source.matchAll(
    /\n(?=<group-info>|<group-state>|<group-context>\n|<group-message |（省略了 \d+ 条)/g
  )) {
    const lead = parseSource(source.slice(0, split.index).trim());
    const tail = parseSource(source.slice(split.index).trim());
    if (lead && lead.kind !== 'group' && tail?.kind === 'group')
      return { ...lead, group: tail.messages };
  }
  return null;
}

function parseSource(source: string): BotInjectedMessage | null {
  const omittedPattern = /^（省略了 \d+ 条更早的消息）\s*/;
  // 委派子会话的群背景：开头的说明行不进消息，块内只能有群消息
  const groupContext = /^<group-context>\n([\s\S]*)\n<\/group-context>$/.exec(source);
  if (groupContext) {
    const start = groupContext[1].search(/^(?:<group-message |（省略了 \d+ 条)/m);
    if (start < 0) return null;
    const parsed = parseSource(groupContext[1].slice(start).replace(omittedPattern, '').trim());
    return parsed?.kind === 'group' && !parsed.instruction && !parsed.note && !parsed.refs
      ? { kind: 'group', messages: parsed.messages, instruction: '' }
      : null;
  }
  if (
    source.startsWith('<group-info>') ||
    source.startsWith('<group-state>') ||
    source.startsWith('<group-message ') ||
    omittedPattern.test(source)
  ) {
    let rest = source
      .replace(/^<group-info>[\s\S]*?<\/group-info>\s*/, '')
      .replace(/^<group-state>[\s\S]*?<\/group-state>\s*/, '');
    const omitted = omittedPattern.exec(rest)?.[0].trim();
    rest = rest.replace(omittedPattern, '');
    const messages: { from: string; text: string }[] = [];
    while (rest.startsWith('<group-message ')) {
      const match = /^<group-message([^>]*)>([\s\S]*?)<\/group-message>\s*/.exec(rest);
      if (!match) return null;
      const attrs = attributes(match[1]);
      if (!attrs?.from) return null;
      messages.push({ from: attrs.from, text: decode(match[2].trim()) });
      rest = rest.slice(match[0].length);
    }
    if (!messages.length) return null;
    const note = /\n*<routing-note>([\s\S]*?)<\/routing-note>\s*$/.exec(rest);
    if (note) rest = rest.slice(0, note.index);
    const { body, refs } = splitChatReferences(rest);
    return {
      kind: 'group',
      messages,
      instruction: decode([omitted, body.trim()].filter(Boolean).join('\n')),
      ...(note ? { note: decode(note[1].trim()) } : {}),
      ...(refs.length ? { refs } : {}),
    };
  }
  const batch = /^<delegation-results(\s[^>]*)?>([\s\S]*)<\/delegation-results>$/.exec(source);
  if (batch) {
    if (!attributes(batch[1] ?? '')) return null;
    let rest = batch[2].trim();
    const results: { from: string; status: string; text: string }[] = [];
    while (rest) {
      const item = /^<delegation-result([^>]*)>([\s\S]*?)<\/delegation-result>\s*/.exec(rest);
      const attrs = item && attributes(item[1]);
      if (!item || !attrs?.from) return null;
      results.push({ from: attrs.from, status: attrs.status ?? '', text: decode(item[2].trim()) });
      rest = rest.slice(item[0].length);
    }
    return results.length ? { kind: 'delegation-results', results } : null;
  }
  const match =
    /^<(routine|delegation-task|delegation-result|delegation-retry|delegation-check-failed)(\s[^>]*)?>([\s\S]*)<\/\1>$/.exec(
      source
    );
  if (!match) return null;
  const attrs = attributes(match[2] ?? '');
  if (!attrs) return null;
  const body = match[3].trim();
  if (match[1] === 'delegation-retry' || match[1] === 'delegation-check-failed') {
    // 正文由 Main 转义后写入，块内不应再有标签
    if (!attrs.id || /[<>]/.test(body)) return null;
    return { kind: match[1], text: decode(body) };
  }
  if (match[1] === 'routine') {
    if (!attrs.title) return null;
    if (attrs['dry-run'] !== 'true')
      return { kind: 'routine', title: attrs.title, prompt: decode(body) };
    const prompt = decode(body.replace(/^\[Dry run\][^\n]*\n*/, ''));
    return { kind: 'routine', title: attrs.title, prompt, dryRun: true };
  }
  if (!attrs.from) return null;
  if (match[1] === 'delegation-result') {
    return {
      kind: 'delegation-result',
      from: attrs.from,
      status: attrs.status ?? '',
      text: decode(body),
    };
  }
  // 尾部的历次执行摘要与验收条件是给成员看的说明，不进正文
  const task = body
    .replace(/\s*<previous-runs>[\s\S]*<\/previous-runs>$/, '')
    .replace(/\s*<acceptance-check>[\s\S]*<\/acceptance-check>$/, '');
  const context = /\s*<context>([\s\S]*)<\/context>$/.exec(task);
  if (!context && /<\/?context>/.test(task)) return null;
  return {
    kind: 'delegation-task',
    from: attrs.from,
    task: decode((context ? task.slice(0, context.index) : task).trim()),
    context: decode(context?.[1].trim() ?? ''),
  };
}
