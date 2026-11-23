import {
  type GoalResult,
  type GoalResultCheck,
  type GoalResultView,
  hasNeedsUser,
} from '@shared/secretary/goalResult';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

const CHIP =
  'inline-flex h-[18px] max-w-full items-center gap-1 rounded-full bg-foreground/[0.06] px-1.5 font-medium';

const STATUS_LABEL = {
  verified: 'Verified',
  mismatch: 'Mismatch',
  unverifiable: 'Could not verify',
} as const;

const STATUS_CLASS = {
  verified: 'text-success',
  mismatch: 'text-destructive',
  unverifiable: 'text-warning',
} as const;

const KIND_TAG: Record<GoalResultCheck['kind'], string> = {
  'pr-state': 'PR',
  'pr-squash': 'squash',
  'pr-branch': 'branch',
  commit: 'sha',
  screenshot: 'img',
  ci: 'CI',
};

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function checkFor(
  checks: readonly GoalResultCheck[] | undefined,
  kind: GoalResultCheck['kind'],
  ref: string
) {
  return checks?.find((check) => check.kind === kind && check.ref === ref);
}

export function GoalResultFacts({
  view,
  detail = false,
}: {
  view: GoalResultView;
  detail?: boolean;
}) {
  const { t } = useI18n();
  const result = view.result;
  const shots = result.screenshots?.length ?? 0;
  const needsUser =
    !detail && hasNeedsUser(view) ? (result.needsUser ?? []).filter((s) => s.trim()) : [];
  return (
    <div data-enso="secretary-goal-result" className="flex flex-col gap-1.5 text-[11.5px]">
      {detail && result.summary && <p className="text-[13px]">{result.summary}</p>}
      <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
        {needsUser.length > 0 && (
          <span
            data-enso="secretary-goal-needs-user"
            className={cn(CHIP, 'text-warning')}
            title={needsUser.join('\n')}
          >
            {t('Needs the user')}: {needsUser[0]}
          </span>
        )}
        {(result.prs ?? []).map((pr) => (
          <a
            key={`${pr.repo}#${pr.number}`}
            href={`https://github.com/${pr.repo}/pull/${pr.number}`}
            target="_blank"
            rel="noreferrer"
            className={cn(CHIP, 'text-foreground hover:underline')}
          >
            {pr.repo}#{pr.number}
            {detail && pr.state ? ` ${pr.state}` : ''}
          </a>
        ))}
        {(result.commits ?? []).map((sha) => (
          <span key={sha} title={sha} className={cn(CHIP, 'font-mono')}>
            {shortSha(sha)}
          </span>
        ))}
        {shots > 0 && <span className={CHIP}>{t('{{count}} screenshots', { count: shots })}</span>}
        {(view.checks ?? []).map((check) => (
          <span
            key={`${check.kind}:${check.ref}:${check.status}:${check.detail ?? ''}`}
            data-enso="secretary-goal-check"
            data-status={check.status}
            className={cn(CHIP, STATUS_CLASS[check.status])}
            title={[check.ref, check.detail].filter(Boolean).join(' · ')}
          >
            {KIND_TAG[check.kind]} {t(STATUS_LABEL[check.status])}
          </span>
        ))}
      </div>
      {detail && <GoalResultDetail result={result} checks={view.checks} />}
    </div>
  );
}

function GoalResultDetail({ result, checks }: { result: GoalResult; checks?: GoalResultCheck[] }) {
  const { t } = useI18n();
  const lines: string[] = [];
  const tests = result.checks?.tests;
  if (tests && (tests.passed !== undefined || tests.failed !== undefined)) {
    lines.push(
      `${t('Tests')} ${tests.passed ?? 0} passed, ${tests.failed ?? 0} failed${tests.note ? ` ${tests.note}` : ''}`
    );
  }
  const ci = result.checks?.ci;
  if (ci) {
    const mark = ci.runId ? checkFor(checks, 'ci', String(ci.runId)) : undefined;
    lines.push(
      ['CI', ci.runId, ci.conclusion, ci.repo, mark ? t(STATUS_LABEL[mark.status]) : '']
        .filter((part) => part !== undefined && part !== '')
        .join(' ')
    );
  }
  if (result.deploy) {
    const bits = [
      result.deploy.needed ? 'needed' : '',
      result.deploy.phone ? 'phone' : '',
      result.deploy.relay ? 'relay' : '',
      result.deploy.note ?? '',
    ].filter(Boolean);
    if (bits.length > 0) lines.push(`${t('Deploy')} ${bits.join(' ')}`);
  }
  return (
    <div className="flex flex-col gap-1 text-[12px] text-muted-foreground">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {(result.followUps ?? []).map((item) => (
        <p key={`follow:${item}`}>
          {t('Follow-up')}: {item}
        </p>
      ))}
      {(result.needsUser ?? []).map((item) => (
        <p key={`need:${item}`}>
          {t('Needs the user')}: {item}
        </p>
      ))}
    </div>
  );
}
