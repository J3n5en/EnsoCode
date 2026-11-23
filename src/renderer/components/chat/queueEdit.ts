import { hasQuoteBlock, quotesAsMarkdown } from '@shared/quoteBlock';

export function canSaveQueuedEdit(text: string, imageCount: number): boolean {
  return text.trim().length > 0 || imageCount > 0;
}

export function queuedAttachmentLabel(count: number, noun: string): string | null {
  return count > 0 ? `${count} ${noun}` : null;
}

export const queuedDisplayText = quotesAsMarkdown;

/** 单行输入框改不了引用块（会露出原始标签）；这类消息撤回到输入框里编辑 */
export function canEditQueuedInline(text: string): boolean {
  return !hasQuoteBlock(text);
}
