import type { ApprovalMode } from '../types/agentConstants';
import type {
  AgyPermissionOption,
  AgyPermissionRequest,
  PermissionAction,
  PermissionResponse,
  UserPermissionDecision,
} from './types';

const EDIT_KINDS = new Set(['edit', 'delete', 'move']);

function optionByKind(
  options: readonly AgyPermissionOption[],
  kind: string
): AgyPermissionOption | undefined {
  return options.find((option) => option.kind === kind);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pathsOf(request: AgyPermissionRequest): string[] {
  const raw = record(request.toolCall.rawInput);
  if (!raw) return [];
  const paths: string[] = [];
  for (const key of ['path', 'absolute_path', 'file_path', 'target']) {
    if (typeof raw[key] === 'string') paths.push(raw[key]);
  }
  if (Array.isArray(raw.paths)) {
    for (const item of raw.paths) {
      if (typeof item === 'string') paths.push(item);
    }
  }
  return paths;
}

function insideWorkspace(target: string, root: string): boolean {
  if (!root) return false;
  const normalizedRoot = root.endsWith('/') ? root : `${root}/`;
  return target === root || target.startsWith(normalizedRoot);
}

function isWorkspaceEdit(request: AgyPermissionRequest, workspaceRoot: string): boolean {
  const kind = request.toolCall.kind ?? '';
  if (!EDIT_KINDS.has(kind)) return false;
  const paths = pathsOf(request);
  return paths.length > 0 && paths.every((target) => insideWorkspace(target, workspaceRoot));
}

function selectAllow(
  options: readonly AgyPermissionOption[],
  preferAlways: boolean
): string | undefined {
  const once = optionByKind(options, 'allow_once');
  const always = optionByKind(options, 'allow_always');
  if (preferAlways) return always?.optionId ?? once?.optionId;
  return once?.optionId ?? always?.optionId;
}

/** 审批档位到 agy 答复。问人的档位不在这里选 option。 */
export function decidePermission(input: {
  approvalMode: ApprovalMode;
  request: AgyPermissionRequest;
  workspaceRoot: string;
}): PermissionAction {
  if (input.approvalMode === 'full') {
    const optionId = selectAllow(input.request.options, false);
    return optionId ? { kind: 'selected', optionId } : { kind: 'ask' };
  }
  if (input.approvalMode === 'auto-edits' && isWorkspaceEdit(input.request, input.workspaceRoot)) {
    const optionId = optionByKind(input.request.options, 'allow_once')?.optionId;
    return optionId ? { kind: 'selected', optionId } : { kind: 'ask' };
  }
  return { kind: 'ask' };
}

export function permissionOutcome(
  decision: UserPermissionDecision,
  options: readonly AgyPermissionOption[]
): PermissionResponse {
  if (decision === 'cancel') return { outcome: 'cancelled' };
  if (decision === 'allow') {
    const optionId = selectAllow(options, false);
    return optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
  }
  if (decision === 'allowSession') {
    const optionId = selectAllow(options, true);
    return optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
  }
  const reject = optionByKind(options, 'reject_once');
  return reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' };
}

/** agy 只接受 default / plan / auto。Enso 的计划模式发 plan，其余发 default。 */
export function sessionModeFor(planMode: boolean): 'plan' | 'default' {
  return planMode ? 'plan' : 'default';
}
