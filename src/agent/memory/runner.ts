import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { MemoryCompleteSimple } from './pipeline';

type Model = Parameters<ModelRuntime['completeSimple']>[0];

export const MEMORY_PHASE1_TIMEOUT_MS = 60_000;
/** 实测 grok-4.6-fast 写 38k 字符的合并结果要 113s，120s 会反复超时 */
export const MEMORY_PHASE2_TIMEOUT_MS = 300_000;

/**
 * 把 ModelRuntime + 已解析模型包成管线需要的 `completeSimple`。
 * 与 supervisor 解耦：CLI / 调试脚本可以自建 runtime 直接跑同一条管线。
 */
export function createMemoryCompleteSimple(opts: {
  runtime: ModelRuntime;
  sessionModel: Model;
  phase2Model?: Model;
  phase1TimeoutMs?: number;
  phase2TimeoutMs?: number;
}): MemoryCompleteSimple {
  const phase1TimeoutMs = opts.phase1TimeoutMs ?? MEMORY_PHASE1_TIMEOUT_MS;
  const phase2TimeoutMs = opts.phase2TimeoutMs ?? MEMORY_PHASE2_TIMEOUT_MS;
  return async ({ systemPrompt, userText, phase }) => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      phase === 1 ? phase1TimeoutMs : phase2TimeoutMs
    );
    try {
      const message = await opts.runtime.completeSimple(
        phase === 2 ? (opts.phase2Model ?? opts.sessionModel) : opts.sessionModel,
        {
          systemPrompt,
          messages: [{ role: 'user', content: userText, timestamp: Date.now() }],
        },
        { signal: controller.signal }
      );
      const content = (message as { content?: unknown }).content;
      return Array.isArray(content)
        ? (content as Array<{ type?: string; text?: string }>)
            .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
            .join('')
        : '';
    } finally {
      clearTimeout(timer);
    }
  };
}
