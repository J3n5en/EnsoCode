import type { AttachedImage } from '@shared/types/agent';
import type {
  ChatMentionCandidate,
  FileMentionCandidate,
  UiElementMentionCandidate,
} from '@shared/types/mentions';

/**
 * Composer 的 insertMention 出口。DndContext 在 App.tsx,而编辑器 ref 在
 * Composer 内部——用模块级注册表桥接,避免把 ref 层层上提。
 * 只有一个主 Composer,后注册覆盖先注册(切会话时重挂)。
 */

type InsertFn = (candidate: FileMentionCandidate | ChatMentionCandidate) => void;

let current: InsertFn | null = null;
let insertText: ((text: string) => void) | null = null;
let focusComposer: (() => void) | null = null;
let insertUiElement:
  | ((candidate: UiElementMentionCandidate, image?: AttachedImage) => void)
  | null = null;
let insertImage: ((image: AttachedImage) => void) | null = null;

export function registerComposerInsert(fn: InsertFn): () => void {
  current = fn;
  return () => {
    if (current === fn) current = null;
  };
}

export function registerComposerFocus(fn: () => void): () => void {
  focusComposer = fn;
  return () => {
    if (focusComposer === fn) focusComposer = null;
  };
}

export function registerComposerInsertText(fn: (text: string) => void): () => void {
  insertText = fn;
  return () => {
    if (insertText === fn) insertText = null;
  };
}

export function requestFocusComposer(): boolean {
  if (!focusComposer) return false;
  focusComposer();
  return true;
}

export function insertComposerMention(
  candidate: FileMentionCandidate | ChatMentionCandidate
): boolean {
  if (!current) return false;
  current(candidate);
  return true;
}

export function insertComposerText(text: string): boolean {
  if (!insertText) return false;
  insertText(text);
  return true;
}

export function registerComposerInsertUiElement(
  fn: (candidate: UiElementMentionCandidate, image?: AttachedImage) => void
): () => void {
  insertUiElement = fn;
  return () => {
    if (insertUiElement === fn) insertUiElement = null;
  };
}

export function insertUiElementMention(
  candidate: UiElementMentionCandidate,
  image?: AttachedImage
): boolean {
  if (!insertUiElement) return false;
  insertUiElement(candidate, image);
  return true;
}

export function registerComposerInsertImage(fn: (image: AttachedImage) => void): () => void {
  insertImage = fn;
  return () => {
    if (insertImage === fn) insertImage = null;
  };
}

export function insertComposerImage(image: AttachedImage): boolean {
  if (!insertImage) return false;
  insertImage(image);
  return true;
}
