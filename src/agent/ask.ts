import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { ASK_TIMEOUT_ERROR } from '@shared/humanRequestTimeout';
import type { AskAnswerBy, AskRequestInfo } from '@shared/types/agent';

/** 转交给秘书的提问等多久：秘书一直不答就按默认值收尾，没有默认值按无人值守拒绝 */
export const ASK_RELAY_TIMEOUT_MS = 30 * 60_000;

/** 提问收尾的信息：原会话据此显示「X 已回答」，Main 据此把结果记到转交记录上 */
export interface AskResolution {
  by: AskAnswerBy;
  answer?: string;
  /** 秘书代答时的名字 */
  name?: string;
}

interface PendingAsk {
  info: AskRequestInfo;
  resolve(answer: string, resolution?: AskResolution): void;
  reject(error: Error): void;
  expire(): void;
}

let counter = 0;

/** 无人值守下的提问拒绝文案：对齐 factory 的 no_approver_available——不是被拒，是没人能答 */
export const ASK_NO_USER_ERROR =
  'Blocked: this session has no user available to answer questions, and asking is not available ' +
  'here. Do not ask in prose and wait. Decide on the most reasonable assumption, state it in one ' +
  "line, and continue. Stop only if the decision is irreversible and would change the user's " +
  'data — then say which decision is needed and what you already did.';

/** agent → 用户提问的挂起管理(与 ApprovalGate 同构:请求经事件上抛,答复经命令回落) */
export class AskManager {
  private readonly pending = new Map<string, PendingAsk>();
  /** 无人值守：没人能回答，提问前就失败，不占卡片也不干等超时 */
  autoReject = false;
  /**
   * 秘书派出/跟踪的会话：提问不自动拒绝，也不在原会话里弹给用户，
   * 而是挂起并转给秘书；秘书答不了再由它自己问用户。
   */
  relay?: { name: string };

  constructor(
    private readonly onRequest: (info: AskRequestInfo) => void,
    private readonly onResolved: (requestId: string, resolution?: AskResolution) => void,
    /** 等真人回答的时限：提问带 expiresAt，由 Main 到期发 request-timeout */
    readonly humanTimeoutMs?: number
  ) {}

  ask(
    question: string,
    options?: string[],
    opts: { signal?: AbortSignal; timeoutMs?: number; defaultAnswer?: string } = {}
  ): Promise<string> {
    const relay = this.relay;
    if (this.autoReject && !relay) return Promise.reject(new Error(ASK_NO_USER_ERROR));
    // 转交的提问一定有超时：秘书不回也不能把会话永久卡住
    const timeoutMs = opts.timeoutMs ?? (relay ? ASK_RELAY_TIMEOUT_MS : undefined);
    const requestId = `ask-${++counter}-${Date.now().toString(36)}`;
    const info: AskRequestInfo = {
      requestId,
      question,
      ...(options && options.length > 0 ? { options } : {}),
      ...(opts.defaultAnswer && options?.includes(opts.defaultAnswer)
        ? { recommended: opts.defaultAnswer }
        : {}),
      ...(relay ? { relay } : {}),
      ...(timeoutMs
        ? { expiresAt: Date.now() + timeoutMs }
        : this.humanTimeoutMs
          ? { expiresAt: Date.now() + this.humanTimeoutMs }
          : {}),
    };
    return new Promise<string>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (fn: () => void, resolution?: AskResolution) => {
        if (timer) clearTimeout(timer);
        this.pending.delete(requestId);
        this.onResolved(requestId, resolution);
        fn();
      };
      this.pending.set(requestId, {
        info,
        resolve: (answer, resolution) => settle(() => resolve(answer), resolution),
        reject: (error) => settle(() => reject(error)),
        expire: () => {
          opts.signal?.removeEventListener('abort', onAbort);
          settle(
            () =>
              opts.defaultAnswer
                ? resolve(`${opts.defaultAnswer} (auto-selected: no response in time)`)
                : reject(new Error(relay ? ASK_NO_USER_ERROR : ASK_TIMEOUT_ERROR)),
            { by: 'timeout' }
          );
        },
      });
      const onAbort = () => settle(() => reject(new Error('question cancelled')));
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      // 超时:有默认答案则视为选中(无人值守不永久卡死),否则取消
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          opts.signal?.removeEventListener('abort', onAbort);
          settle(
            () =>
              opts.defaultAnswer
                ? resolve(`${opts.defaultAnswer} (auto-selected: no response in time)`)
                : reject(new Error(relay ? ASK_NO_USER_ERROR : 'question timed out')),
            { by: 'timeout' }
          );
        }, timeoutMs);
      }
      this.onRequest(info);
    });
  }

  respond(
    requestId: string,
    answer: string,
    meta?: { by?: 'user' | 'relay'; name?: string }
  ): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    entry.resolve(answer, {
      by: meta?.by ?? 'user',
      answer,
      ...(meta?.name ? { name: meta.name } : {}),
    });
  }

  /** Main 判定等人超时：按未回答收尾 */
  expire(requestId: string): void {
    this.pending.get(requestId)?.expire();
  }

  /** abort/dismiss 时取消全部挂起提问(fail-closed) */
  cancelAll(reason = 'question cancelled'): void {
    for (const [requestId, entry] of this.pending) {
      this.onResolved(requestId);
      entry.reject(new Error(reason));
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
          description:
            'Optional: your recommended answer. If it equals one of the options it is marked ' +
            'Recommended; it is also auto-selected when the timeout elapses',
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
