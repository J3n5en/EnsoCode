/**
 * 子代理运行脚注:把"它到底做了什么"用一行事实压给主 agent —— 工具调用分布(shell 0 一眼看出没跑过命令)、
 * 耗时、是否撞输出上限、上下文占用。全部来自会话本地消息,零额外成本。
 */
export interface RunFooterInput {
  messages: readonly unknown[];
  label: string;
  modelId: string;
  elapsedMs: number;
  contextWindow?: number;
}

interface LooseMessage {
  role?: string;
  content?: unknown;
  stopReason?: string;
  usage?: { input?: number; output?: number };
}

function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

export function runFooter(input: RunFooterInput): string {
  const counts = new Map<string, number>();
  let lastAssistant: LooseMessage | undefined;
  for (const raw of input.messages) {
    const message = raw as LooseMessage | null;
    if (!message || typeof message !== 'object' || message.role !== 'assistant') continue;
    lastAssistant = message;
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as unknown[]) {
      const call = part as { type?: string; name?: unknown } | null;
      if (call?.type === 'toolCall' && typeof call.name === 'string') {
        counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
      }
    }
  }
  const tools =
    counts.size === 0
      ? 'no tool calls'
      : [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([name, n]) => `${name} ${n}`)
          .join(', ') + (counts.has('bash') || counts.has('powershell') ? '' : ' · shell 0');
  const parts = [input.label, input.modelId, formatElapsed(input.elapsedMs), tools];
  const used = (lastAssistant?.usage?.input ?? 0) + (lastAssistant?.usage?.output ?? 0);
  if (input.contextWindow && used > 0) {
    parts.push(`ctx ${Math.round((used / input.contextWindow) * 100)}%`);
  }
  if (lastAssistant?.stopReason === 'length') parts.push('INCOMPLETE: hit output limit');
  return `[${parts.join(' · ')}]`;
}
