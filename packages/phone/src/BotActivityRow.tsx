import type { PairBotActivity, PairBotActivityStep, PairBotMember } from '@enso/pair';
import { Check, ChevronRight, Clock, Loader2, Slash, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { BotAvatar } from './BotAvatar';
import { activityStateText, formatElapsed } from './botState';

interface Props {
  item: PairBotActivity;
  bots: ReadonlyMap<string, PairBotMember>;
  /** 本机时钟 − host 时钟 */
  clockOffset: number;
  onOpen?(conversationId: string): void;
}

function StepIcon({ status }: { status: PairBotActivityStep['status'] }) {
  if (status === 'running') return <Loader2 className="h-3 w-3 shrink-0 animate-spin text-brand" />;
  if (status === 'done') return <Check className="h-3 w-3 shrink-0 text-muted-foreground" />;
  if (status === 'denied') return <Slash className="h-3 w-3 shrink-0 text-muted-foreground" />;
  if (status === 'timeout') return <Clock className="h-3 w-3 shrink-0 text-warning" />;
  return <X className="h-3 w-3 shrink-0 text-destructive" />;
}

/** 成员正在做什么：状态、本轮计时、最近工具步骤；点开看完整过程 */
export function BotActivityRow({ item, bots, clockOffset, onOpen }: Props) {
  const bot = bots.get(item.botId);
  const owner = item.ownerBotId ? bots.get(item.ownerBotId) : undefined;
  const running = item.state !== 'queued';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const hostNow = now - clockOffset;
  const open = running && onOpen ? () => onOpen(item.conversationId) : undefined;

  return (
    <button
      type="button"
      disabled={!open}
      onClick={open}
      className="flex w-full gap-2 rounded-lg border bg-muted/30 px-2.5 py-2 text-left disabled:cursor-default"
    >
      <BotAvatar bot={bot} size="sm" busy={running} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-xs">
          <span className="truncate font-medium">
            {bot?.name ?? '成员'}
            {owner ? (
              <span className="font-normal text-muted-foreground"> 替 {owner.name}</span>
            ) : null}
          </span>
          <span className={cn('shrink-0', running ? 'text-brand' : 'text-muted-foreground')}>
            {activityStateText(item)}
          </span>
          {running && item.startedAt !== undefined && (
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {formatElapsed(hostNow - item.startedAt)}
            </span>
          )}
          {open && <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        </span>
        {item.more > 0 && (
          <span className="mt-1 block text-[11px] text-muted-foreground">
            +{item.more} 个更早的步骤
          </span>
        )}
        {item.steps.map((step, index) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: 步骤按顺序追加，下标即身份
            key={index}
            className="mt-1 flex items-center gap-1.5 text-[11px]"
          >
            <StepIcon status={step.status} />
            <span className="shrink-0 font-medium">{step.name}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
              {step.detail}
            </span>
            {step.status === 'timeout' && (
              <span className="shrink-0 text-warning">
                {step.name === 'ask_user' ? '已超时未回答' : '已超时拒绝'}
              </span>
            )}
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {step.durationMs !== undefined
                ? formatElapsed(step.durationMs)
                : step.startedAt !== undefined
                  ? formatElapsed(hostNow - step.startedAt)
                  : ''}
            </span>
          </span>
        ))}
      </span>
    </button>
  );
}
