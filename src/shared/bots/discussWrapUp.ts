import { BOT_DISCUSS_MAX_TURNS, type BotChat, type BotChatRouting, type BotId } from '../types/bot';

/**
 * 讨论结束后的群主收尾（#33）：安全上限、「有新内容才进候选」、收尾与否及提示文案。
 * 智能选人讨论与成员自选（#22）共用，只依赖计数与群主，不依赖判断模型。
 */

/** 讨论结束原因：有结论 / 到安全上限 / 没人能接话 / 判断不可用 */
export type DiscussEndReason = 'concluded' | 'cap' | 'idle' | 'judge-failed';

/** 讨论主链里至少有这么多条有效发言（非 [skip]、非失败）才收尾 */
export const DISCUSS_WRAP_UP_MIN_REPLIES = 2;

/** 群的讨论安全上限：缺省或非法按缺省值，越界夹紧 */
export function discussCap(routing: Pick<BotChatRouting, 'discussMaxTurns'> | undefined): number {
  const value = routing?.discussMaxTurns;
  if (!Number.isSafeInteger(value)) return BOT_DISCUSS_MAX_TURNS.default;
  return Math.min(BOT_DISCUSS_MAX_TURNS.max, Math.max(BOT_DISCUSS_MAX_TURNS.min, value as number));
}

/**
 * seen：成员上次发言（含 [skip] 与失败）时看到的最新有效发言 seq；latest：当前最新有效发言 seq。
 * 没发过言的成员总有新内容可看；发过言的只有在之后出现了新的有效发言时才有。
 */
export function hasNewContent(seen: number | undefined, latest: number): boolean {
  return seen === undefined || latest > seen;
}

export interface WrapUpOwner {
  id: BotId;
  name: string;
}

/** 可以收尾的群主：设了群主、仍在群里且未归档（群主不可静音，不必看静音） */
export function wrapUpOwner(
  chat: Pick<BotChat, 'members' | 'bossBotId'>,
  members: readonly { id: BotId; name: string; archivedAt?: number }[]
): WrapUpOwner | null {
  const id = chat.bossBotId;
  if (!id || !chat.members.includes(id)) return null;
  const boss = (Array.isArray(members) ? members : []).find((m) => m?.id === id);
  return boss && boss.archivedAt === undefined ? { id: boss.id, name: boss.name } : null;
}

export interface WrapUpInput {
  reason: DiscussEndReason;
  /** 讨论主链里的有效发言条数 */
  replies: number;
  boss: WrapUpOwner | null;
  cap: number;
  /** reason 为 judge-failed 时的原因 */
  failure?: string;
  /** 讨论最后一位发言人就是群主 */
  bossWasLast: boolean;
  /** 开场人类消息的 seq */
  rootSeq: number;
}

export type WrapUpPlan =
  | { kind: 'wrap-up'; botId: BotId; note: string; notice?: string }
  | { kind: 'end'; notice?: string };

const capText = (cap: number) => `本次讨论已达安全上限（${cap} 次成员发言）`;
const failedText = (failure: string | undefined) => `讨论判断不可用（${failure ?? '未知原因'}）`;

/** 结束时：收尾（附注 + 可选提示）或只发结束提示；提示先于收尾写入时间线，群主能在增量里看到原因 */
export function planWrapUp(input: WrapUpInput): WrapUpPlan {
  const { reason, boss } = input;
  if (input.replies < DISCUSS_WRAP_UP_MIN_REPLIES) {
    if (reason === 'cap') return { kind: 'end', notice: `${capText(input.cap)}，讨论结束。` };
    if (reason === 'idle') return { kind: 'end', notice: '没有其他可接话的成员，讨论结束。' };
    if (reason === 'judge-failed')
      return { kind: 'end', notice: `${failedText(input.failure)}，讨论结束` };
    return { kind: 'end' };
  }
  if (!boss) {
    const notice =
      reason === 'concluded'
        ? '讨论已有结论，但群里没有可用的群主，未收尾。'
        : reason === 'cap'
          ? `${capText(input.cap)}，未达成结论。群里没有可用的群主，请你决定下一步。`
          : reason === 'idle'
            ? '没有成员再接话，讨论结束。群里没有可用的群主，未收尾。'
            : `${failedText(input.failure)}，讨论结束。群里没有可用的群主，未收尾。`;
    return { kind: 'end', notice };
  }
  const note = buildWrapUpNote(input);
  const handOver = `交给群主「${boss.name}」收尾。`;
  if (reason === 'concluded') return { kind: 'wrap-up', botId: boss.id, note };
  const notice =
    reason === 'cap'
      ? `${capText(input.cap)}，${handOver}`
      : reason === 'idle'
        ? `没有成员再接话，${handOver}`
        : `${failedText(input.failure)}，${handOver}`;
  return { kind: 'wrap-up', botId: boss.id, note, notice };
}

/** 收尾投递附的 routing-note：不附讨论 note（那条写着不要委派） */
export function buildWrapUpNote(
  input: Pick<WrapUpInput, 'reason' | 'cap' | 'failure' | 'rootSeq' | 'bossWasLast'>
): string {
  const lead =
    input.reason === 'concluded'
      ? '判断认为讨论已有结论或明确的下一步。'
      : input.reason === 'cap'
        ? `讨论已达安全上限（${input.cap} 次成员发言），还没有达成结论。收尾开头写明「未达成结论」，列出卡住的点和各方主张，交给用户决定。`
        : input.reason === 'idle'
          ? '成员都没有新的补充了，如果还没有结论，开头写明「未达成结论」。'
          : `${failedText(input.failure)}，讨论先停在这里，如果还没有结论，开头写明「未达成结论」。`;
  return [
    lead,
    '讨论结束，请你作为群主收尾。分三段写：结论、分歧、下一步；需要用户拍板的事项单独列在「需要你决定」下。',
    '可以委派去落实下一步；这次回复里的 @ 只是提醒，不会让对方接着发言。',
    `不要复述成员原话，需要原文用 group_history 查（本次讨论从 seq ${input.rootSeq} 开始）。不要回 [skip]。`,
    input.bossWasLast
      ? '你刚才的发言是讨论的最后一条：已经写过的不要重复，只补齐缺的部分（尤其是需要用户决定的事项）。'
      : '',
  ]
    .filter(Boolean)
    .join('');
}
