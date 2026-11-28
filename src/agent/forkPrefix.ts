import {
  type Message,
  renderSystemMessageUpdate,
  type SystemMessage,
  type UserMessage,
} from '@earendil-works/pi-ai';

/**
 * seed_context="fork" 子代理的请求改写。
 *
 * 子会话 transcript 以父会话某次请求的消息原样起头（含承载系统提示与工具声明的 system 消息），
 * 子代理自己的提示段与工具差异由 pi 在首轮以 system 消息补在前缀之后。不支持中途 system 消息的
 * provider 会把全部 system 消息折叠回请求头，子代理的差异就改写了父前缀，缓存一个字节都命中不了。
 * 所以每次请求：
 * - 前缀位置换回注入时的原样消息（子会话自己的 context 变换会改历史图片、旧工具结果）；
 * - 紧跟前缀的那段子代理 system 补丁降成下一条 user 消息里的正文，请求头与工具声明保持父会话原样。
 * 声明了但子代理不能执行的工具，调用时 pi 按「Tool not found」报错，不会执行。
 * 前缀对不上（子会话已压缩等）时原样返回，不改写。
 */
export function withForkPrefix<T extends { messages: Message[] }>(
  prefix: readonly Message[] | undefined,
  context: T
): T {
  if (!prefix || prefix.length === 0) return context;
  const { messages } = context;
  if (messages.length < prefix.length) return context;
  for (let i = 0; i < prefix.length; i++) {
    if (messages[i].role !== prefix[i].role || messages[i].timestamp !== prefix[i].timestamp) {
      return context;
    }
  }
  const tail = messages.slice(prefix.length);
  const firstOwn = tail.findIndex((message) => message.role !== 'system');
  const patchEnd = firstOwn < 0 ? tail.length : firstOwn;
  const patches = tail.slice(0, patchEnd) as SystemMessage[];
  const rest = tail.slice(patchEnd);
  const note = patches.map(renderForkPatch).filter(Boolean).join('\n\n');
  return { ...context, messages: [...prefix, ...withNote(rest, note, patches[0]?.timestamp)] };
}

function renderForkPatch(message: SystemMessage): string {
  const removed = (message.toolsRemoved ?? []).map((tool) => `- ${tool.name}`);
  return [
    renderSystemMessageUpdate(message),
    removed.length > 0
      ? `These tools are declared above but disabled for this forked subagent; calls to them fail:\n${removed.join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function withNote(rest: Message[], note: string, timestamp = 0): Message[] {
  if (!note) return rest;
  const text = `<fork_system_update>\n${note}\n</fork_system_update>`;
  const [first, ...others] = rest;
  if (first?.role !== 'user') {
    const user: UserMessage = { role: 'user', content: text, timestamp };
    return [user, ...rest];
  }
  const content =
    typeof first.content === 'string'
      ? `${text}\n\n${first.content}`
      : [{ type: 'text' as const, text }, ...first.content];
  return [{ ...first, content }, ...others];
}
