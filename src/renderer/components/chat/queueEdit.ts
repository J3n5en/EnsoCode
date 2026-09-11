export function canSaveQueuedEdit(text: string, imageCount: number): boolean {
  return text.trim().length > 0 || imageCount > 0;
}

export function queuedAttachmentLabel(count: number, noun: string): string | null {
  return count > 0 ? `${count} ${noun}` : null;
}
