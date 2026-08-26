import type { ApprovalDecision, ApprovalRequestInfo } from '@shared/types/agent';
import { FileEdit, FilePlus, Plug, ShieldAlert, TerminalSquare } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '@/i18n';

const KIND_ICONS = {
  command: TerminalSquare,
  'file-edit': FileEdit,
  'file-write': FilePlus,
  mcp: Plug,
} as const;

interface ApprovalBarProps {
  approvals: ApprovalRequestInfo[];
  onRespond: (requestId: string, decision: ApprovalDecision) => void;
}

/** composer 上方的审批条（ref-chat-a 形态）：只渲染队首，>1 显示 1/N；summary 全文可滚动 */
export function ApprovalBar({ approvals, onRespond }: ApprovalBarProps) {
  const { t } = useI18n();
  const [responding, setResponding] = useState<string | null>(null);
  const active = approvals[0];
  if (!active) return null;
  const Icon = KIND_ICONS[active.kind] ?? ShieldAlert;
  const disabled = responding === active.requestId;
  const respond = (decision: ApprovalDecision) => {
    setResponding(active.requestId);
    onRespond(active.requestId, decision);
  };

  return (
    <div className="mb-1 rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2">
      <div className="flex items-center gap-2 text-xs">
        <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-500" />
        <span className="shrink-0 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          {t('Approval required')}
        </span>
        <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
          <Icon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate font-mono">{active.tool}</span>
        </span>
        {approvals.length > 1 && (
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground tabular-nums">
            1/{approvals.length}
          </span>
        )}
      </div>
      {active.summary && (
        // 刻意不截断:长命令可滚动查看全文（ref-chat-a 语义）
        <pre className="mt-1.5 max-h-24 overflow-auto rounded-md bg-muted/50 px-2 py-1.5 font-mono text-xs whitespace-pre-wrap">
          {active.summary}
        </pre>
      )}
      <div className="mt-2 flex items-center justify-end gap-1.5">
        <button
          type="button"
          disabled={disabled}
          onClick={() => respond('deny')}
          className="rounded-md px-2.5 py-1 text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
        >
          {t('Deny')}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => respond('allowSession')}
          className="rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          {t('Always allow this session')}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => respond('allow')}
          className="rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {t('Allow')}
        </button>
      </div>
    </div>
  );
}
