import type { MentionSegment } from '@/components/chat/mentionComposer';

/** 主输入框登记给插件草稿桥的句柄；key 是输入框当前的会话（focusKey） */
export interface DraftTarget {
  key: string;
  segments(): readonly MentionSegment[];
  insertText(text: string): void;
  setText(text: string): void;
  /** 输入法组字中或被审批锁定 */
  busy(): boolean;
}

export interface DraftRequest {
  sessionId: string;
  op:
    | 'readDraft'
    | 'insertText'
    | 'replaceDraft'
    | 'focusSession'
    | 'focusSubagent'
    | 'openChildRun'
    | 'createSession'
    | 'ensureSession';
  payload: Record<string, unknown>;
}

export type DraftResult = { ok: true; value: unknown } | { ok: false; code: string; error: string };

let current: DraftTarget | null = null;
/** 新建会话时插件给的首条文本：输入框切到该会话时取走，只填不发 */
const pending = new Map<string, string>();

export function registerDraftTarget(target: DraftTarget): () => void {
  current = target;
  return () => {
    if (current === target) current = null;
  };
}

export function prefillDraft(key: string, text: string): void {
  if (current?.key === key && !current.busy()) {
    current.setText(text);
    return;
  }
  pending.set(key, text);
}

export function takePendingDraft(key: string): string | undefined {
  const text = pending.get(key);
  pending.delete(key);
  return text;
}

/** 草稿内容指纹：内容不变指纹不变，用作 replaceDraft 的乐观锁 */
export function draftRev(segments: readonly MentionSegment[]): string {
  const text = JSON.stringify(segments);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length.toString(36)}.${(hash >>> 0).toString(36)}`;
}

const fail = (code: string, error: string): DraftResult => ({ ok: false, code, error });

export function handleDraftRequest(req: DraftRequest): DraftResult {
  if (req.op === 'focusSession' || req.op === 'createSession')
    return fail('INVALID_ARGS', '不是草稿操作');
  const target = current;
  if (!target || target.key !== req.sessionId) return fail('NO_COMPOSER', '该会话的输入框不在前台');
  const segments = target.segments();
  const hasReferences = segments.some((segment) => segment.type !== 'text');
  if (req.op === 'readDraft') {
    const text = segments.map((segment) => (segment.type === 'text' ? segment.text : '')).join('');
    return {
      ok: true,
      value: { text, hasReferences, generation: target.key, rev: draftRev(segments) },
    };
  }
  const text = req.payload.text;
  if (typeof text !== 'string') return fail('INVALID_ARGS', 'text 必须是字符串');
  if (target.busy()) return fail('DRAFT_BUSY', '输入框正在组字或已锁定');
  if (req.op === 'insertText') {
    target.insertText(text);
    return { ok: true, value: { rev: draftRev(target.segments()) } };
  }
  if (hasReferences) return fail('DRAFT_HAS_REFERENCES', '草稿里有文件或会话引用，不能整体替换');
  const expected = req.payload.expect;
  if (expected !== undefined) {
    const record = typeof expected === 'object' && expected !== null ? expected : {};
    const { generation, rev } = record as { generation?: unknown; rev?: unknown };
    if (generation !== target.key || rev !== draftRev(segments))
      return fail('DRAFT_CHANGED', '草稿在读取之后被改过');
  }
  target.setText(text);
  return { ok: true, value: { rev: draftRev(target.segments()) } };
}
