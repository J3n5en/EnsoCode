import type { InlineExtension, ToolDefinition } from '@earendil-works/pi-coding-agent';

export type ToolExecuteResult = Awaited<ReturnType<ToolDefinition['execute']>>;

export function toolResultText(result: ToolExecuteResult): string {
  return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
}

export function toolResultIsError(result: ToolExecuteResult): boolean {
  return (result as { isError?: boolean }).isError === true;
}

type ReminderProvider = {
  name: string;
  take: () => string[];
  priority: number;
};

/** 按 priority 高到低收集本轮待注入 reminder；单个 provider 失败不影响其余。 */
export class SystemReminderRegistry {
  private providers: ReminderProvider[] = [];

  register(name: string, take: () => string[], priority = 0): this {
    this.providers.push({ name, take, priority });
    return this;
  }

  takePending(): string[] {
    const ranked = [...this.providers].sort((a, b) => b.priority - a.priority);
    const blocks: string[] = [];
    for (const provider of ranked) {
      try {
        const pending = provider.take();
        if (Array.isArray(pending)) {
          for (const block of pending) {
            if (typeof block === 'string' && block.trim()) blocks.push(block);
          }
        }
      } catch {
        // fail-open：单个 provider 不得阻断工具结果
      }
    }
    return blocks;
  }
}

export function systemReminderBlock(body: string): string {
  return `<system-reminder>\n${body}\n</system-reminder>`;
}

export function prependToolText<T extends ToolExecuteResult>(result: T, prefix: string): T {
  if (!prefix) return result;
  const content = [...(result.content ?? [])];
  const firstText = content.find((part) => part.type === 'text');
  if (firstText && firstText.type === 'text') {
    firstText.text = `${prefix}\n\n${firstText.text}`;
  } else {
    content.unshift({ type: 'text', text: prefix });
  }
  return { ...result, content };
}

function withPendingReminders<T extends ToolExecuteResult>(
  result: T,
  registry: SystemReminderRegistry
): T | undefined {
  const pending = registry.takePending();
  if (pending.length === 0) return undefined;
  const tagged = pending.map((block) =>
    block.includes('<system-reminder>') || block.includes('<background-task-update>')
      ? block
      : systemReminderBlock(block)
  );
  return prependToolText(result, tagged.join('\n\n'));
}

/** Cursor bridge 绕过 pi 的工具循环、收不到 tool_result 事件，只能包在工具上。 */
export function withSystemReminders(
  definition: ToolDefinition,
  registry: SystemReminderRegistry
): ToolDefinition {
  return {
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = await definition.execute(toolCallId, params, signal, onUpdate, ctx);
      return withPendingReminders(result, registry) ?? result;
    },
  };
}

/**
 * 挂在 tool_result 上而不是包工具：codemode、tool_search 等由扩展注册的工具不经过 Enso 的工具装饰。
 * 嵌套调用的结果只进脚本，提醒留给外层结果。
 */
export function systemReminderExtension(registry: SystemReminderRegistry): InlineExtension {
  return {
    name: 'system-reminders',
    hidden: true,
    factory: (pi) => {
      pi.on('tool_result', (event) => {
        if (event.parentToolCallId) return;
        const next = withPendingReminders({ content: event.content, details: undefined }, registry);
        return next ? { content: next.content } : undefined;
      });
    },
  };
}
