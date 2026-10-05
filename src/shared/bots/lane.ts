/** 投递来源：human = 人在私聊 / 群里发、直接指派；bot = 群接力、委派任务与结果；background = 例行任务 */
export type BotDeliverySource = 'human' | 'bot' | 'background';

const RANK: Record<BotDeliverySource, number> = { human: 0, bot: 1, background: 2 };

/** 按来源插队：排在同级及更高优先级的最后一项之后，同级先来先出；缺省按 bot */
export function enqueueByLane<T extends { source?: BotDeliverySource }>(
  queue: readonly T[],
  item: T
): T[] {
  const rank = RANK[item.source ?? 'bot'];
  const index = queue.findIndex((queued) => RANK[queued.source ?? 'bot'] > rank);
  return index < 0 ? [...queue, item] : [...queue.slice(0, index), item, ...queue.slice(index)];
}
