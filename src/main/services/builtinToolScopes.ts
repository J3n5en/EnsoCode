import type { SessionIdentity } from '@shared/types/agent';
import {
  projectDisabledBuiltinTools,
  resolveDisabledBuiltinTools,
} from '@shared/types/builtinTools';

type ToolSettings = { disabledBuiltinTools?: unknown; projects?: unknown } | undefined;

/** 会话的有效禁用列表：设置（项目覆盖优先）+ 会话固定禁用 + 平台不支持的 computer */
export function sessionDisabledTools(
  state: ToolSettings,
  projectId: string | undefined,
  extra: readonly string[],
  computerSupported: boolean
): string[] {
  const disabled = resolveDisabledBuiltinTools(state?.disabledBuiltinTools, {
    disabledBuiltinTools: projectDisabledBuiltinTools(state?.projects, projectId),
  });
  for (const id of extra) if (!disabled.includes(id)) disabled.push(id);
  if (!computerSupported && !disabled.includes('computer')) disabled.push('computer');
  return disabled;
}

/** 会话固定开启的开关从有效禁用列表里去掉（秘书的记忆分组不受全局设置影响） */
export function withoutKeepEnabled(
  disabled: readonly string[],
  keepEnabled: readonly string[]
): string[] {
  return disabled.filter((id) => !keepEnabled.includes(id));
}

interface Scope {
  identity: SessionIdentity;
  projectId?: string;
  extra: readonly string[];
  /** 会话固定开启的开关：设置变化重算后仍然去掉，不推回给 worker */
  keepEnabled: readonly string[];
  sent: string;
}

/** 记录活着的父会话的工具口径，设置变化时只产出结果变了的推送 */
export class BuiltinToolScopes {
  private readonly scopes = new Map<string, Scope>();

  remember(
    identity: SessionIdentity,
    projectId: string | undefined,
    extra: readonly string[],
    disabled: readonly string[],
    keepEnabled: readonly string[] = []
  ): void {
    this.scopes.set(identity.sessionId, {
      identity,
      ...(projectId ? { projectId } : {}),
      extra: [...extra],
      keepEnabled: [...keepEnabled],
      sent: JSON.stringify(withoutKeepEnabled(disabled, keepEnabled)),
    });
  }

  forget(sessionId: string): void {
    this.scopes.delete(sessionId);
  }

  changes(
    state: ToolSettings,
    computerSupported: boolean
  ): Array<{ identity: SessionIdentity; disabledTools: string[] }> {
    const out: Array<{ identity: SessionIdentity; disabledTools: string[] }> = [];
    for (const scope of this.scopes.values()) {
      const disabledTools = withoutKeepEnabled(
        sessionDisabledTools(state, scope.projectId, scope.extra, computerSupported),
        scope.keepEnabled
      );
      const key = JSON.stringify(disabledTools);
      if (key === scope.sent) continue;
      scope.sent = key;
      out.push({ identity: scope.identity, disabledTools });
    }
    return out;
  }
}
