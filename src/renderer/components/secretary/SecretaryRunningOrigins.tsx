import type { SecretaryBoard, SecretaryCard, SecretaryState } from '@shared/types/secretary';
import { Loader2 } from 'lucide-react';
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from '@/components/ui/preview-card';
import { useI18n } from '@/i18n';
import { openSessionPeek } from '@/stores/sessionPeek';

export interface RunningOriginGroup {
  /** null = 未知来源：记录没有发起会话，或那条会话已不在 */
  secretaryConversationId: string | null;
  cards: SecretaryCard[];
}

export interface RunningOrigins {
  /** 按发起会话计的在跑件数，口径与头部「N 件在跑」同为 board.running */
  counts: Record<string, number>;
  groups: RunningOriginGroup[];
}

function originOf(card: SecretaryCard): string | undefined {
  if (card.kind === 'session') return card.secretaryConversationId;
  if (card.kind === 'pending') return card.pending.secretaryConversationId;
  return card.proposal.secretaryConversationId;
}

export function runningByOrigin(
  board: Pick<SecretaryBoard, 'running'>,
  known: (conversationId: string) => boolean
): RunningOrigins {
  const counts: Record<string, number> = {};
  const byId = new Map<string, SecretaryCard[]>();
  const unknown: SecretaryCard[] = [];
  for (const card of board.running) {
    const id = originOf(card);
    if (!id || !known(id)) {
      unknown.push(card);
      continue;
    }
    counts[id] = (counts[id] ?? 0) + 1;
    const list = byId.get(id);
    if (list) list.push(card);
    else byId.set(id, [card]);
  }
  const groups: RunningOriginGroup[] = [...byId].map(([secretaryConversationId, cards]) => ({
    secretaryConversationId,
    cards,
  }));
  if (unknown.length > 0) groups.push({ secretaryConversationId: null, cards: unknown });
  return { counts, groups };
}

/** 多个秘书时各按自己的看板分组，计数与悬停列表只落在对应分区 */
export function runningBySecretary(
  secretaries: readonly { id: string }[],
  states: Readonly<Record<string, Pick<SecretaryState, 'board'> | undefined>>,
  known: (conversationId: string) => boolean
): Record<string, RunningOrigins> {
  const result: Record<string, RunningOrigins> = {};
  for (const { id } of secretaries) {
    const state = states[id];
    if (state) result[id] = runningByOrigin(state.board, known);
  }
  return result;
}

function cardKey(card: SecretaryCard): string {
  if (card.kind === 'session') return `s:${card.conversationId}`;
  if (card.kind === 'pending') return `p:${card.pending.id}`;
  return `x:${card.proposal.id}`;
}

function cardTitle(card: SecretaryCard): string | undefined {
  if (card.kind === 'session') return card.title;
  if (card.kind === 'pending') return card.pending.draft.title;
  return undefined;
}

/** 秘书会话行右侧：它派出的活还有几件在跑；左侧圆点只表示秘书自己在回复 */
export function SecretaryDispatchBadge({ count }: { count: number | undefined }) {
  const { t } = useI18n();
  if (!count) return null;
  return (
    <span
      data-enso="secretary-dispatch-running"
      title={t('{{n}} dispatched tasks running', { n: count })}
      className="inline-flex shrink-0 items-center gap-0.5 text-[10px] tabular-nums text-muted-foreground/70"
    >
      <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
      {count}
    </span>
  );
}

export interface RunningOriginsLink {
  groups: RunningOriginGroup[];
  titleOf: (conversationId: string) => string | undefined;
  onSelect: (conversationId: string) => void;
}

/** 头部「N 件在跑」：悬停列出每件属于哪条秘书会话；点组头跳秘书会话，点某件弹窗看它 */
export function SecretaryRunningOriginsCard({
  label,
  groups,
  titleOf,
  onSelect,
}: RunningOriginsLink & { label: string }) {
  const { t } = useI18n();
  return (
    <PreviewCard>
      <PreviewCardTrigger
        render={<span data-enso="secretary-running-origins" className="shrink-0" />}
      >
        {label}
      </PreviewCardTrigger>
      <PreviewCardPopup
        align="start"
        className="w-[260px] flex-col p-1 text-[12.5px]"
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        {groups.map((group) => {
          const id = group.secretaryConversationId;
          const name = id ? titleOf(id) || t('New conversation') : t('Unknown source');
          const head = (
            <>
              <span className="min-w-0 flex-1 truncate">{name}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                {group.cards.length}
              </span>
            </>
          );
          return (
            <div key={id ?? ''} data-enso="secretary-running-origin" className="py-0.5">
              {id ? (
                <button
                  type="button"
                  onClick={() => onSelect(id)}
                  className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-foreground/5"
                >
                  {head}
                </button>
              ) : (
                <div className="flex items-center gap-2 px-1.5 py-1 text-muted-foreground">
                  {head}
                </div>
              )}
              {group.cards.map((card) =>
                card.kind === 'session' ? (
                  <button
                    key={cardKey(card)}
                    type="button"
                    data-enso="secretary-running-origin-card"
                    onClick={() => openSessionPeek(card.conversationId, undefined, id ?? undefined)}
                    className="block w-full truncate rounded-md pr-1.5 pl-4 text-left text-[11.5px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                  >
                    {cardTitle(card) || t('Unnamed')}
                  </button>
                ) : (
                  <div
                    key={cardKey(card)}
                    className="truncate pr-1.5 pl-4 text-[11.5px] text-muted-foreground"
                  >
                    {cardTitle(card) || t('Unnamed')}
                  </div>
                )
              )}
            </div>
          );
        })}
      </PreviewCardPopup>
    </PreviewCard>
  );
}
