/**
 * Cursor interaction_query：权限门必须作答，否则心跳不算进度、idle watchdog 会掐断活轮。
 * 宿主搜索/抓取门放行；需要完整交互 UI 的帧拒绝，避免停在未实现表面。
 */

const APPROVE = new Set([
  'webSearchRequestQuery',
  'exaSearchRequestQuery',
  'exaFetchRequestQuery',
  'webFetchRequestQuery',
]);

const REJECT = new Set([
  'askQuestionInteractionQuery',
  'switchModeRequestQuery',
  'createPlanRequestQuery',
]);

export interface CursorInteractionQuery {
  id?: number;
  queryCase?: string | null;
}

export interface CursorInteractionDecision {
  handled: boolean;
  action: 'approve' | 'reject' | 'ignore';
  /** 写回流上的语义：approved / rejected；ignore 表示不写以免谎报成功 */
  response: 'approved' | 'rejected' | 'unanswered';
  queryCase: string;
}

export function handleCursorInteractionQuery(
  query: CursorInteractionQuery
): CursorInteractionDecision {
  const queryCase = query.queryCase || 'unknown';
  if (APPROVE.has(queryCase)) {
    return { handled: true, action: 'approve', response: 'approved', queryCase };
  }
  if (REJECT.has(queryCase)) {
    return { handled: true, action: 'reject', response: 'rejected', queryCase };
  }
  if (queryCase === 'setupVmEnvironmentArgs') {
    return { handled: true, action: 'ignore', response: 'unanswered', queryCase };
  }
  // 未知名权限门也拒绝，避免流停住
  return { handled: true, action: 'reject', response: 'rejected', queryCase };
}
