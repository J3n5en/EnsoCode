import type { AttachedImage } from '@shared/types/agent';
import type {
  ChatMentionCandidate,
  FileMentionCandidate,
  UiElementMentionCandidate,
} from '@shared/types/mentions';
import type { ComposerPayload } from './mentionComposer';

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
let ingestFiles: ((files: File[]) => void) | null = null;
let insertPaths: ((paths: string[]) => void) | null = null;
let submitPayload: ((payload: ComposerPayload) => boolean) | null = null;

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

export function registerComposerSubmitPayload(
  fn: (payload: ComposerPayload) => boolean
): () => void {
  submitPayload = fn;
  return () => {
    if (submitPayload === fn) submitPayload = null;
  };
}

export function submitComposerPayload(payload: ComposerPayload): boolean {
  if (!submitPayload) return false;
  return submitPayload(payload);
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

/** OS 拖入文件的全窗遮罩「引用」区投递到主 Composer，与 Composer 自身 onDrop 同一入口。 */
export function registerComposerIngestFiles(fn: (files: File[]) => void): () => void {
  ingestFiles = fn;
  return () => {
    if (ingestFiles === fn) ingestFiles = null;
  };
}

export function composerAcceptsFiles(): boolean {
  return ingestFiles !== null;
}

export function ingestComposerFiles(files: File[]): boolean {
  if (!ingestFiles) return false;
  ingestFiles(files);
  return true;
}

/** 拖放浮窗投来的磁盘路径，插为文件卡片 */
export function registerComposerInsertPaths(fn: (paths: string[]) => void): () => void {
  insertPaths = fn;
  return () => {
    if (insertPaths === fn) insertPaths = null;
  };
}

export function insertComposerPaths(paths: string[]): boolean {
  if (!insertPaths) return false;
  insertPaths(paths);
  return true;
}
