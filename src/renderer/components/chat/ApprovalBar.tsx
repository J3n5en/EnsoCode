import type { ApprovalReviewFallback } from '@shared/approvalReviewRecord';
import { explainDcgGuard } from '@shared/dcgRuleHints';
import { isDcgRuleExemptible } from '@shared/dcgRuleMemory';
import { isNestedToolCallId } from '@shared/toolCallId';
import type { ApprovalDecision, ApprovalKind, ApprovalRequestInfo } from '@shared/types/agent';
import {
  type DcgGuardHit,
  type DcgRuleState,
  type DcgSeverity,
  TEMP_ROOT_RULE_ID,
} from '@shared/types/dcg';
import { FileEdit, FilePlus, Plug, ShieldAlert, TerminalSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useI18n } from '@/i18n';
import { protectedActionLabel } from '@/lib/protectedAction';
import { toolLabel } from '@/lib/toolLabels';
import { CopyButton } from './CopyButton';
import { RequestCountdown, useRemainingMs } from './RequestCountdown';
import { codeToHtml } from './snippetHighlighter';

const KIND_ICONS = {
  command: TerminalSquare,
  'file-edit': FileEdit,
  'file-write': FilePlus,
  mcp: Plug,
} as const;

interface ApprovalBarProps {
  approvals: ApprovalRequestInfo[];
  onRespond: (requestId: string, decision: ApprovalDecision) => void;
  /** Enso 能力审批是一次性的，绝不能提供 allowSession。 */
  allowSession?: boolean;
  /** 打回换命令、交给助手代审。能力审批不提供。 */
  handoff?: boolean;
  /** 本机时钟 − host 时钟（手机伴侣显示剩余时间用） */
  clockOffset?: number;
}

/** 审批详情:command 走 shell 语法高亮,其余(文件路径/MCP 参数)素文本。
 *  刻意不截断:长命令可滚动查看全文（ref-chat-a 语义） */
function SummaryView({ kind, summary }: { kind: ApprovalKind; summary: string }) {
  // 高亮结果连同原文一起存：换成下一条命令后，旧高亮不能在新高亮出来前顶替新命令显示
  const [highlighted, setHighlighted] = useState<{
    summary: string;
    html: string | null;
  } | null>(null);
  useEffect(() => {
    if (kind !== 'command') return;
    let alive = true;
    codeToHtml(summary, 'shellscript').then((out) => {
      if (alive) setHighlighted({ summary, html: out });
    });
    return () => {
      alive = false;
    };
  }, [kind, summary]);
  const html = highlighted?.summary === summary ? highlighted.html : null;

  const copy = (
    <CopyButton
      text={summary}
      className="absolute top-1 right-1 z-10 rounded-md bg-background/80 p-1 text-muted-foreground backdrop-blur"
    />
  );

  if (kind === 'command' && html != null) {
    return (
      <div className="relative mt-1.5">
        <div
          className="max-h-24 overflow-auto rounded-md text-xs leading-relaxed [&_pre]:m-0 [&_pre]:py-1.5 [&_pre]:pr-7 [&_pre]:pl-2 [&_pre]:font-mono [&_pre]:whitespace-pre-wrap"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki 输出的受控 HTML（本地生成，无用户注入）
          dangerouslySetInnerHTML={{ __html: html }}
        />
        {copy}
      </div>
    );
  }
  return (
    <div className="relative mt-1.5">
      <pre className="max-h-24 overflow-auto rounded-md bg-muted/50 py-1.5 pr-7 pl-2 font-mono text-xs whitespace-pre-wrap">
        {summary}
      </pre>
      {copy}
    </div>
  );
}
const REVIEW_FALLBACK_LABELS: Record<ApprovalReviewFallback, string> = {
  timeout: 'Auto-managed review timed out. Please decide.',
  error: 'Auto-managed review failed. Please decide.',
  invalid: 'Auto-managed review returned no valid decision. Please decide.',
};

/** 规则记忆只走桌面端本机 IPC；手机伴侣没有 */
const dcgApi = () =>
  typeof window === 'undefined' || window.electronAPI?.remote ? undefined : window.electronAPI?.dcg;

const SEVERITY_LABELS: Record<DcgSeverity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

function BuiltinGuardDetail({ guard }: { guard: DcgGuardHit }) {
  const { t } = useI18n();
  const isTempRoot = guard.ruleId === TEMP_ROOT_RULE_ID;
  return (
    <div className="mt-1 space-y-0.5 text-[11px]">
      <p className="text-destructive">
        {t(guard.reason)}{' '}
        <code className="rounded bg-muted/60 px-1 font-mono text-[10px] text-muted-foreground">
          {guard.ruleId}
        </code>
      </p>
      <p className="text-muted-foreground">
        {isTempRoot
          ? t(
              'Safety floor rule — still requires confirmation in full-access mode. Click Adjust to target a specific subdirectory or session temp folder, or Allow once.'
            )
          : t(
              'Blocked by built-in guard — still requires confirmation in full-access mode. Review the command, click Adjust, or Allow once.'
            )}
      </p>
    </div>
  );
}

function DcgGuardDetail({ guard }: { guard: DcgGuardHit }) {
  const { t, locale } = useI18n();
  const [rule, setRule] = useState<{ ruleId: string; state: DcgRuleState } | null>(null);
  const warn = guard.decision === 'warn';
  const canRemember = guard.decision === undefined || guard.decision === 'deny';
  const exemptible = isDcgRuleExemptible(guard.ruleId);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!canRemember) return;
    let alive = true;
    setConfirming(false);
    void dcgApi()
      ?.ruleState(guard.ruleId)
      .then((state) => {
        if (alive && state) setRule({ ruleId: guard.ruleId, state });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [guard.ruleId, canRemember]);
  const state = rule?.ruleId === guard.ruleId ? rule.state : null;
  const explained = locale === 'zh' ? explainDcgGuard(guard) : { what: guard.reason };
  const exempt = () => {
    setConfirming(false);
    void dcgApi()
      ?.ruleExempt(guard.ruleId)
      .then((next) => {
        if (next) setRule({ ruleId: guard.ruleId, state: next });
      })
      .catch(() => {});
  };

  return (
    <div className="mt-1 space-y-0.5 text-[11px]">
      <p className={warn ? 'text-muted-foreground' : 'text-destructive'} title={guard.ruleId}>
        {guard.severity && (
          <span className="mr-1 rounded bg-muted px-1 text-[10px]">
            {t(SEVERITY_LABELS[guard.severity])}
          </span>
        )}
        {t(warn ? 'dcg notice: {{reason}}' : 'dcg: {{reason}}', { reason: explained.what })}
        <code className="ml-1 rounded bg-muted/60 px-1 font-mono text-[10px] text-muted-foreground">
          {guard.ruleId}
        </code>
      </p>
      {!warn && (
        <p className="text-muted-foreground">
          {!exemptible
            ? t(
                'High-risk safety floor (cannot be exempted) — still requires confirmation in full-access mode. Click Adjust for a safer command or path, or Allow once.'
              )
            : guard.decision === 'ask'
              ? t(
                  'Guard rule requires confirmation each time — still prompts in full-access mode. Click Adjust for a safer command, or Allow once.'
                )
              : t(
                  'Triggered by command guard — still prompts in full-access mode. Click Adjust to change the command or path, or manage exemptions in Settings (auto-suggested after 5 allows).'
                )}
        </p>
      )}
      {guard.matched && (
        <p className="text-muted-foreground">
          {t('Matched')}:{' '}
          <code className="rounded bg-muted/60 px-1 font-mono">{guard.matched}</code>
        </p>
      )}
      {explained.why && (
        <p className="text-muted-foreground">
          {t('Why it is dangerous')}: {explained.why}
        </p>
      )}
      {explained.alt && (
        <div className="flex items-center gap-1 text-muted-foreground">
          <span>{t('Safer alternative')}:</span>
          <code className="rounded bg-muted/60 px-1 font-mono">{explained.alt}</code>
          <CopyButton text={explained.alt} className="p-0.5" />
        </div>
      )}
      {guard.explanation && (
        <details className="text-muted-foreground">
          <summary className="cursor-pointer">{t('dcg explanation')}</summary>
          <p className="whitespace-pre-wrap">{guard.explanation}</p>
        </details>
      )}
      {state?.suggestExempt && (
        <div className="flex flex-wrap items-center gap-2 text-amber-600 dark:text-amber-400">
          {confirming ? (
            <>
              <span>
                {t(
                  'Allow "{{rule}}" automatically in new conversations? You can revoke this anytime in Settings.',
                  { rule: guard.ruleId }
                )}
              </span>
              <button
                type="button"
                onClick={exempt}
                className="font-medium underline underline-offset-2"
              >
                {t('Confirm exemption')}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="text-muted-foreground underline underline-offset-2"
              >
                {t('Cancel')}
              </button>
            </>
          ) : (
            <>
              <span>
                {t(
                  'You have allowed this rule {{count}} times. Allow it automatically from now on?',
                  {
                    count: state.allowCount,
                  }
                )}
              </span>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="underline underline-offset-2"
              >
                {t('Always allow this rule')}
              </button>
            </>
          )}
        </div>
      )}
      {state?.exempt && (
        <p className="text-muted-foreground">
          {t('This rule is allowed automatically in new conversations until dcg is updated.')}
        </p>
      )}
    </div>
  );
}

/** 队首换成新请求后的锁定时长：批完一条，下一条几十毫秒内出现在原位，双击的第二下会落在它上面 */
const ARM_DELAY_MS = 400;

/** composer 上方的审批条（ref-chat-a 形态）：只渲染队首，>1 显示 1/N；summary 全文可滚动 */
export function ApprovalBar({
  approvals,
  onRespond,
  allowSession = true,
  handoff = true,
  clockOffset,
}: ApprovalBarProps) {
  const { t } = useI18n();
  const [responding, setResponding] = useState<string | null>(null);
  const [armedId, setArmedId] = useState<string | null>(null);
  const active = approvals[0];
  const activeId = active?.requestId;
  const remainingMs = useRemainingMs(
    active?.phase === 'reviewing' ? undefined : active?.expiresAt,
    clockOffset
  );
  useEffect(() => {
    if (!activeId) return;
    const timer = setTimeout(() => setArmedId(activeId), ARM_DELAY_MS);
    return () => clearTimeout(timer);
  }, [activeId]);
  if (!active) return null;
  const Icon = KIND_ICONS[active.kind] ?? ShieldAlert;
  const reviewing = active.phase === 'reviewing';
  const disabled =
    armedId !== active.requestId ||
    responding === active.requestId ||
    (remainingMs !== undefined && remainingMs <= 0);
  const respond = (decision: ApprovalDecision) => {
    // 代审可能原卡退回，不能把按钮锁死
    if (decision !== 'review') setResponding(active.requestId);
    if (
      decision === 'allow' &&
      active.guard &&
      (active.guard.decision === undefined || active.guard.decision === 'deny') &&
      !active.guard.ruleId.startsWith('enso.')
    )
      void dcgApi()
        ?.ruleAllowed(active.guard.ruleId)
        .catch(() => {});
    onRespond(active.requestId, decision);
  };

  return (
    <div
      data-enso="approval"
      className="mb-1 rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2"
    >
      <div className="flex items-center gap-2 text-xs">
        <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-500" />
        <span className="shrink-0 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          {reviewing ? t('Assistant reviewing…') : t('Approval required')}
        </span>
        <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
          <Icon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate font-mono">
            {active.toolCallId && isNestedToolCallId(active.toolCallId)
              ? `${t('Isolated sandbox')} › ${toolLabel(active.tool, t)}`
              : toolLabel(active.tool, t)}
          </span>
        </span>
        {active.protected && (
          <span className="shrink-0 rounded bg-destructive/15 px-1.5 text-[10px] text-destructive">
            {protectedActionLabel(active.protected, t)}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <RequestCountdown remainingMs={remainingMs} expiredLabel="Timed out · denied" />
          {approvals.length > 1 && (
            <span className="text-[10px] text-muted-foreground tabular-nums">
              1/{approvals.length}
            </span>
          )}
        </span>
      </div>
      {active.reviewFallback && (
        <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
          {t(REVIEW_FALLBACK_LABELS[active.reviewFallback])}
        </p>
      )}
      {active.guard &&
        (active.guard.ruleId.startsWith('enso.') ? (
          <BuiltinGuardDetail guard={active.guard} />
        ) : (
          <DcgGuardDetail guard={active.guard} />
        ))}
      {active.summary && <SummaryView kind={active.kind} summary={active.summary} />}
      {!reviewing && (
        <div className="mt-2 flex items-center justify-end gap-1.5">
          {handoff && active.kind === 'command' && (
            <button
              type="button"
              disabled={disabled}
              title={t('Send back for a safer command')}
              onClick={() => respond('revise')}
              className="rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              {t('Adjust')}
            </button>
          )}
          {handoff && (
            <button
              type="button"
              disabled={disabled}
              title={t('Let the assistant decide')}
              onClick={() => respond('review')}
              className="rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              {t('Assistant review')}
            </button>
          )}
          <button
            type="button"
            disabled={disabled}
            onClick={() => respond('deny')}
            className="rounded-md px-2.5 py-1 text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
          >
            {t('Deny')}
          </button>
          {allowSession && !active.protected && !active.mandatory && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => respond('allowSession')}
              className="rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              {t('Always allow this session')}
            </button>
          )}
          <button
            type="button"
            disabled={disabled}
            onClick={() => respond('allow')}
            className="rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {t('Allow')}
          </button>
        </div>
      )}
    </div>
  );
}
