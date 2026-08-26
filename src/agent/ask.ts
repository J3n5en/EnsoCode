import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AskRequestInfo } from '@shared/types/agent';

interface PendingAsk {
  info: AskRequestInfo;
  resolve(answer: string): void;
  reject(error: Error): void;
}

let counter = 0;

/** agent → 用户提问的挂起管理(与 ApprovalGate 同构:请求经事件上抛,答复经命令回落) */
export class AskManager {
  private readonly pending = new Map<string, PendingAsk>();

  constructor(
    private readonly onRequest: (info: AskRequestInfo) => void,
    private readonly onResolved: (requestId: string) => void
  ) {}

  ask(
    question: string,
    options?: string[],
    opts: { signal?: AbortSignal; timeoutMs?: number; defaultAnswer?: string } = {}
  ): Promise<string> {
    const requestId = `ask-${++counter}-${Date.now().toString(36)}`;
    const info: AskRequestInfo = {
      requestId,
      question,
      ...(options && options.length > 0 ? { options } : {}),
    };
    return new Promise<string>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (fn: () => void) => {
        if (timer) clearTimeout(timer);
        this.pending.delete(requestId);
        this.onResolved(requestId);
        fn();
      };
      this.pending.set(requestId, {
        info,
        resolve: (answer) => settle(() => resolve(answer)),
        reject: (error) => settle(() => reject(error)),
      });
      const onAbort = () => settle(() => reject(new Error('question cancelled')));
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      // 超时:有默认答案则视为选中(无人值守不永久卡死),否则取消
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        timer = setTimeout(() => {
          opts.signal?.removeEventListener('abort', onAbort);
          settle(() =>
            opts.defaultAnswer
              ? resolve(`${opts.defaultAnswer} (auto-selected: no response in time)`)
              : reject(new Error('question timed out'))
          );
        }, opts.timeoutMs);
      }
      this.onRequest(info);
    });
  }

  respond(requestId: string, answer: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    this.onResolved(requestId);
    entry.resolve(answer);
  }

  /** abort/dismiss 时取消全部挂起提问(fail-closed) */
  cancelAll(): void {
    for (const [requestId, entry] of this.pending) {
      this.onResolved(requestId);
      entry.reject(new Error('question cancelled'));
    }
    this.pending.clear();
  }

  snapshot(): AskRequestInfo[] {
    return [...this.pending.values()].map((entry) => entry.info);
  }
}

/** ask_user 工具:向用户提问并阻塞等答复(决策真正属于用户时才用) */
export function createAskTool(manager: AskManager): ToolDefinition {
  return {
    name: 'ask_user',
    label: 'Ask user',
    description:
      'Ask the user a question and wait for their answer. Use ONLY when a decision genuinely ' +
      'belongs to the user (ambiguous requirements, irreversible choices, preferences you cannot ' +
      'infer) — not for confirmations you can resolve yourself. Provide 2-4 short options when ' +
      'the choices are enumerable; the user can always type a free-form answer instead. ' +
      'For unattended/long-running work, pass timeout_seconds + default_option so it does not block forever.',
    promptSnippet:
      'ask_user: ask the user a question and block until answered — only for decisions that are ' +
      'genuinely theirs (ambiguity, irreversible choices, preferences); offer 2-4 options when enumerable',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, clear and specific' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional 2-4 short quick-pick options',
        },
        timeout_seconds: {
          type: 'number',
          description:
            'Optional: auto-resolve after N seconds (use with default_option for unattended runs)',
        },
        default_option: {
          type: 'string',
          description: 'Optional: answer to auto-select when the timeout elapses',
        },
      },
      required: ['question'],
    } as unknown as ToolDefinition['parameters'],
    async execute(_toolCallId, params, signal) {
      const {
        question = '',
        options,
        timeout_seconds: timeoutSeconds,
        default_option: defaultOption,
      } = params as {
        question?: string;
        options?: string[];
        timeout_seconds?: number;
        default_option?: string;
      };
      if (!question.trim()) throw new Error('question is required');
      const answer = await manager.ask(question.trim(), options?.slice(0, 4), {
        signal,
        ...(typeof timeoutSeconds === 'number' && timeoutSeconds > 0
          ? { timeoutMs: timeoutSeconds * 1000 }
          : {}),
        ...(defaultOption ? { defaultAnswer: defaultOption } : {}),
      });
      return { content: [{ type: 'text' as const, text: answer }], details: undefined };
    },
  };
}
