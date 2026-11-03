import type { DraftResult } from './draftBridge';

export interface SessionRequest {
  sessionId: string;
  op: 'focusSession' | 'createSession' | 'ensureSession';
  payload: Record<string, unknown>;
}

export interface SessionBridgeDeps {
  conversation(id: string): { projectId: string; parentId?: string } | null;
  /** 选中主会话；target 是子会话时再切到它的标签 */
  focus(rootId: string, target: string): void;
  /** 新建并选中，返回会话 id */
  create(projectId: string): Promise<string | null>;
  prefill(sessionId: string, text: string): void;
  /** 启动没在运行的会话，返回失败原因 */
  ensure(sessionId: string): Promise<string | null>;
}

const fail = (code: string, error: string): DraftResult => ({ ok: false, code, error });

/** 插件的会话操作在发起窗口执行：Main 已校验权限、手势与会话归属 */
export async function handleSessionRequest(
  req: SessionRequest,
  deps: SessionBridgeDeps
): Promise<DraftResult> {
  if (req.op === 'focusSession') {
    const target = req.payload.sessionId;
    const conversation = typeof target === 'string' ? deps.conversation(target) : null;
    if (typeof target !== 'string' || !conversation) return fail('NOT_FOUND', '会话不在本窗口');
    deps.focus(conversation.parentId ?? target, target);
    return { ok: true, value: null };
  }
  // 后台插件投递时会话还没起来：sessionId 就是要启动的会话
  if (req.op === 'ensureSession') {
    const conversation = deps.conversation(req.sessionId);
    if (!conversation) return fail('NOT_FOUND', '会话不在本窗口');
    if (conversation.parentId) return fail('UNSUPPORTED', '子会话随主会话恢复');
    const error = await deps.ensure(req.sessionId);
    return error ? fail('SESSION_FAILED', error) : { ok: true, value: null };
  }
  const origin = deps.conversation(req.sessionId);
  if (!origin) return fail('NO_SESSION', '发起调用的会话不在本窗口');
  const id = await deps.create(origin.projectId);
  if (!id) return fail('CREATE_FAILED', '新建会话失败');
  const text = req.payload.text;
  if (typeof text === 'string' && text) deps.prefill(id, text);
  return { ok: true, value: { sessionId: id } };
}
