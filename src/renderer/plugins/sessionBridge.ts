import type { DraftResult } from './draftBridge';

export interface SessionRequest {
  sessionId: string;
  op:
    | 'focusSession'
    | 'focusSubagent'
    | 'openChildRun'
    | 'createSession'
    | 'ensureSession'
    | 'openPluginView';
  payload: Record<string, unknown>;
}

export interface SessionBridgeDeps {
  conversation(id: string): { projectId: string; parentId?: string } | null;
  /** 选中主会话；target 是子会话时再切到它的标签 */
  focus(rootId: string, target: string): void;
  /** 子代理不是标签页，切到会话后由 TaskBar 展开它的详情 */
  focusSubagent(sessionId: string, agentId: string): void;
  /** 打开某个子会话的历史弹窗；已结束的 coworker 只能这样看 */
  openChildRun(parentId: string, childId: string): void;
  /** 新建并选中，返回会话 id；presetId 让插件建的会话带上自己的预设 */
  create(projectId: string, presetId?: string): Promise<string | null>;
  prefill(sessionId: string, text: string): void;
  /** 启动没在运行的会话，返回失败原因 */
  ensure(sessionId: string): Promise<string | null>;
  /** 打开右侧栏并创建或定位到插件侧栏页面 */
  openPluginView?(
    sessionId: string,
    view: { pluginId: string; viewId: string; title: string }
  ): void;
}

const fail = (code: string, error: string): DraftResult => ({ ok: false, code, error });

/** 插件的会话操作在发起窗口执行：Main 已校验权限、手势与会话归属 */
export async function handleSessionRequest(
  req: SessionRequest,
  deps: SessionBridgeDeps
): Promise<DraftResult> {
  if (req.op === 'focusSession') {
    const target = req.payload.sessionId;
    if (typeof target !== 'string' || !target) return fail('BAD_REQUEST', '缺少会话 id');
    const conversation = deps.conversation(target);
    if (conversation) {
      deps.focus(conversation.parentId ?? target, target);
      return { ok: true, value: null };
    }
    // coworker 是独立会话，上面就命中了；这里只剩子代理，它没有会话实体，靠 TaskBar 展开
    const cut = target.indexOf('::');
    if (cut > 0) {
      const rootId = target.slice(0, cut);
      if (!deps.conversation(rootId)) return fail('NOT_FOUND', '会话不在本窗口');
      deps.focusSubagent(rootId, target);
      return { ok: true, value: null };
    }
    return fail('NOT_FOUND', '会话不在本窗口');
  }
  if (req.op === 'openChildRun') {
    const parentId = req.payload.parentId;
    const childId = req.payload.childId;
    if (typeof parentId !== 'string' || !parentId) return fail('BAD_REQUEST', '缺少父会话 id');
    if (typeof childId !== 'string' || !childId) return fail('BAD_REQUEST', '缺少子会话 id');
    if (!deps.conversation(parentId)) return fail('NOT_FOUND', '会话不在本窗口');
    deps.openChildRun(parentId, childId);
    return { ok: true, value: null };
  }
  if (req.op === 'focusSubagent') {
    const sessionId = req.payload.sessionId;
    const agentId = req.payload.agentId;
    if (typeof sessionId !== 'string' || !deps.conversation(sessionId))
      return fail('NOT_FOUND', '会话不在本窗口');
    if (typeof agentId !== 'string' || !agentId) return fail('BAD_REQUEST', '缺少子代理 id');
    deps.focusSubagent(sessionId, agentId);
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
  if (req.op === 'openPluginView') {
    if (!deps.conversation(req.sessionId)) return fail('NOT_FOUND', '会话不在本窗口');
    const { pluginId, viewId, title } = req.payload;
    if (
      typeof pluginId !== 'string' ||
      !pluginId ||
      typeof viewId !== 'string' ||
      !viewId ||
      typeof title !== 'string' ||
      !title
    )
      return fail('BAD_REQUEST', '缺少视图标识');
    deps.openPluginView?.(req.sessionId, { pluginId, viewId, title });
    return { ok: true, value: null };
  }
  const origin = deps.conversation(req.sessionId);
  if (!origin) return fail('NO_SESSION', '发起调用的会话不在本窗口');
  const presetId = typeof req.payload.presetId === 'string' ? req.payload.presetId : undefined;
  const id = await deps.create(origin.projectId, presetId);
  if (!id) return fail('CREATE_FAILED', '新建会话失败');
  const text = req.payload.text;
  if (typeof text === 'string' && text) deps.prefill(id, text);
  return { ok: true, value: { sessionId: id } };
}
