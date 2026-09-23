import {
  groupWorkflowMembers,
  type WorkflowMemberSnapshot,
  type WorkflowMemberStatus,
  type WorkflowRunStatus,
  type WorkflowRunSnapshot,
} from '@shared/types/workflow';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { useWorkflowRunsStore } from '@/stores/workflowRuns';

const STATUS_CLASS: Record<WorkflowRunStatus | WorkflowMemberStatus, string> = {
  running: 'bg-amber-500',
  completed: 'bg-emerald-500',
  failed: 'bg-destructive',
  cancelled: 'bg-muted-foreground',
};

const EMPTY_RUNS: WorkflowRunSnapshot[] = [];

function openMember(conversationId: string, childId: string): void {
  const sessions = useSessionsStore.getState();
  if (sessions.activeId !== conversationId) sessions.selectConversation(conversationId);
  sessions.selectTab(conversationId, childId);
}

function MemberRow({
  conversationId,
  member,
}: {
  conversationId: string;
  member: WorkflowMemberSnapshot;
}) {
  const { t } = useI18n();
  const body = (
    <>
      <div className="flex items-center gap-2">
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_CLASS[member.status])} />
        <span className="min-w-0 flex-1 truncate">{member.label}</span>
        <span className="text-muted-foreground">{t(member.status)}</span>
      </div>
      {member.prompt ? (
        <p className="mt-0.5 truncate pl-3.5 text-muted-foreground">{member.prompt}</p>
      ) : null}
      {member.result ? (
        <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap pl-3.5 text-foreground/80">
          {member.result}
        </p>
      ) : null}
    </>
  );
  const childId = member.childId;
  if (!childId) return <li className="text-xs">{body}</li>;
  return (
    <li>
      <button
        type="button"
        className="w-full rounded px-1 py-0.5 text-left text-xs hover:bg-muted/60"
        onClick={() => openMember(conversationId, childId)}
      >
        {body}
      </button>
    </li>
  );
}

export function WorkflowView({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const runs =
    useWorkflowRunsStore((state) => state.byConversation[conversationId]) ?? EMPTY_RUNS;
  if (runs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {t('No workflow runs')}
      </div>
    );
  }
  return (
    <div className="h-full overflow-auto bg-background p-3">
      <div className="space-y-3">
        {runs.map((run) => (
          <section key={run.runId} className="rounded-md border px-3 py-2">
            <div className="flex items-center gap-2">
              <span className={cn('h-2 w-2 shrink-0 rounded-full', STATUS_CLASS[run.status])} />
              <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{run.name}</h3>
              <span className="text-xs text-muted-foreground">{t(run.status)}</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{run.description}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              {t('{{count}} agents', { count: run.members.length })}
            </p>
            <div className="mt-2 space-y-2">
              {groupWorkflowMembers(run.members).map((group, index, groups) => {
                const showPhase = Boolean(group.phase) && group.phase !== groups[index - 1]?.phase;
                return (
                  <div key={`${group.batch}:${group.phase ?? ''}`}>
                    <div className="mb-1 flex items-center gap-2 text-xs">
                      {showPhase ? <span className="font-medium">{group.phase}</span> : null}
                      {group.members.length > 1 ? (
                        <span className="text-muted-foreground">{t('Parallel')}</span>
                      ) : null}
                    </div>
                    <ul className="space-y-1">
                      {group.members.map((member) => (
                        <MemberRow
                          key={member.seq}
                          conversationId={conversationId}
                          member={member}
                        />
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
            {run.error ? <p className="mt-2 text-xs text-destructive">{run.error}</p> : null}
            {run.logs.length > 0 ? (
              <p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">
                {run.logs.join('\n')}
              </p>
            ) : null}
          </section>
        ))}
      </div>
    </div>
  );
}
