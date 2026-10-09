import {
  DISCUSS_JUDGE_MAX_TOKENS,
  type DiscussNextDecision,
  type DiscussNextInput,
  discussNextPrompt,
  discussNextQuestion,
  parseDiscussNext,
  pickDiscussNext,
} from '../../../shared/bots/discussRoute';
import {
  addressesEveryone,
  decideSmartRoute,
  guessSmartRouteIntent,
  parseSmartRouteIntent,
  parseSmartRouteReply,
  parseSmartRouteTask,
  pickSmartRouteChoice,
  pickSmartRouteIntent,
  pickSmartRouteTask,
  rankSmartRouteChoice,
  SMART_ROUTE_DEFAULT_TIMEOUT_MS,
  SMART_ROUTE_JUDGE_MAX_TOKENS,
  type SmartRouteDecision,
  type SmartRouteInput,
  type SmartRouteTask,
  smartRouteChoiceRecognized,
  smartRouteIntentQuestion,
  smartRouteJudgePrompt,
  smartRouteQuestion,
  smartRouteReplyLeadsWithOwner,
  smartRouteReplyNamesBoss,
  smartRouteTaskQuestion,
  smartRouteTimeoutMs,
} from '../../../shared/bots/smartRoute';
import type { DefaultModelRef } from '../../../shared/defaultModel';
import {
  parseVirtualClassifier,
  type VirtualClassifierConfig,
} from '../../../shared/virtualModels';
import type { GroupResponderSelector } from './groupChat';
import { briefErrorReason } from './modelProbe';

/** 选人模型回了结果但认不出名单：群里提示「智能选人不可用（判断结果无法识别）」后交给群主 */
const unrecognized = (): SmartRouteDecision => ({ ids: [], failure: '判断结果无法识别' });

export interface SmartRouterDeps {
  settings: () => Record<string, unknown> | undefined;
  /** 便宜模型一次性补全：preferred 排最前，其后是标题模型回退链；没有可用模型返回 null */
  judge: (
    request: {
      systemPrompt: string;
      userText: string;
      preferred: DefaultModelRef | undefined;
      timeoutMs: number;
      maxTokens?: number;
    },
    signal: AbortSignal
  ) => Promise<string | null>;
  /** pi 分类器 choice 问题；分类器不可用返回 null */
  classify: (
    config: VirtualClassifierConfig,
    question:
      | ReturnType<typeof smartRouteQuestion>
      | ReturnType<typeof smartRouteIntentQuestion>
      | ReturnType<typeof smartRouteTaskQuestion>
      | ReturnType<typeof discussNextQuestion>,
    signal: AbortSignal
  ) => Promise<Record<string, number> | null>;
}

/** 落定名单里有忙碌成员且消息是独立新任务：标 separate */
function markSeparate(
  input: SmartRouteInput,
  decision: SmartRouteDecision,
  task: SmartRouteTask | undefined
): SmartRouteDecision {
  const busy = decision.ids.some((id) => input.candidates.find((c) => c.id === id)?.busy);
  return busy && task === 'new' ? { ...decision, separate: true } : decision;
}

const firstBusy = (input: SmartRouteInput, ids: readonly string[]) =>
  ids.find((id) => input.candidates.find((c) => c.id === id)?.busy);

/**
 * 全局「群聊选人模型」：未设置走 judge + 标题模型回退链；judge 指定快模型；pi-classifier 走 worker 分类
 * （成员与意图各问一次）。判不出意图（含意图概率表不合法）时用关键词兜底，不算失败；
 * 成员概率表不合法、judge 回复既没有名单也不是 BOSS 时报「判断结果无法识别」，交给群主。
 */
export function createSmartRouter(deps: SmartRouterDeps): GroupResponderSelector {
  const config = () => {
    const parsed = parseVirtualClassifier(deps.settings()?.botRouteClassifier);
    return parsed && { ...parsed, timeoutMs: smartRouteTimeoutMs(parsed) };
  };
  return {
    timeoutMs: () => config()?.timeoutMs ?? SMART_ROUTE_DEFAULT_TIMEOUT_MS,
    async select(input: SmartRouteInput, signal: AbortSignal) {
      // 点名全员时规则直出，不受模型挑人上限与置信度影响
      if (addressesEveryone(input.message))
        return { ids: input.candidates.map((candidate) => candidate.id), everyone: true };
      try {
        const current = config();
        if (current?.source === 'pi-classifier') {
          const [probabilities, intents] = await Promise.all([
            deps.classify(current, smartRouteQuestion(input), signal),
            Promise.resolve()
              .then(() => deps.classify(current, smartRouteIntentQuestion(input), signal))
              .catch(() => null),
          ]);
          if (!probabilities) return { ids: [], failure: '选人模型不可用' };
          if (!smartRouteChoiceRecognized(probabilities, input)) {
            console.warn(
              '[bots] smart routing classifier result not understood:',
              JSON.stringify(probabilities).slice(0, 120)
            );
            return unrecognized();
          }
          const decision = decideSmartRoute(
            input,
            pickSmartRouteIntent(intents) ?? guessSmartRouteIntent(input.message),
            pickSmartRouteChoice(probabilities, input),
            rankSmartRouteChoice(probabilities, input)
          );
          const busy = firstBusy(input, decision.ids);
          if (!busy) return decision;
          const task = await deps
            .classify(current, smartRouteTaskQuestion(input, busy), signal)
            .catch(() => null);
          return markSeparate(input, decision, pickSmartRouteTask(task));
        }
        const text = await deps.judge(
          {
            ...smartRouteJudgePrompt(input),
            preferred: current?.model,
            timeoutMs: current?.timeoutMs ?? SMART_ROUTE_DEFAULT_TIMEOUT_MS,
            maxTokens: SMART_ROUTE_JUDGE_MAX_TOKENS,
          },
          signal
        );
        if (text === null) return { ids: [], failure: '选人模型不可用' };
        const picked = parseSmartRouteReply(text, input);
        if (picked.length === 0 && !smartRouteReplyNamesBoss(text)) {
          console.warn('[bots] smart routing reply not understood:', text.slice(0, 80));
          return unrecognized();
        }
        // judge 名单是模型明确点的名（BOSS 或群主名字排第一都算点名群主）；pi 分类器里群主是带「默认人选」
        // 说明的普通候选，概率最高也不算明确点名
        const decision = decideSmartRoute(
          input,
          parseSmartRouteIntent(text) ?? guessSmartRouteIntent(input.message),
          picked,
          picked,
          { ownerFirst: smartRouteReplyLeadsWithOwner(text, input) }
        );
        return markSeparate(input, decision, parseSmartRouteTask(text));
      } catch (error) {
        if (signal.aborted) return { ids: [] };
        console.warn('[bots] smart routing failed', error);
        return { ids: [], failure: briefErrorReason(error) };
      }
    },
    /**
     * 讨论判断与选人共用同一后端设置与时限规则（smartRouteTimeoutMs）：未设置 / judge 走 judge 回退链，
     * pi-classifier 走分类器（含 end 选项）
     */
    async next(input: DiscussNextInput, signal: AbortSignal): Promise<DiscussNextDecision> {
      try {
        const current = config();
        if (current?.source === 'pi-classifier') {
          const probabilities = await deps.classify(current, discussNextQuestion(input), signal);
          if (!probabilities) return { failure: '判断模型不可用' };
          const picked = pickDiscussNext(probabilities, input);
          if ('failure' in picked)
            console.warn(
              '[bots] discuss classifier result not understood:',
              JSON.stringify(probabilities).slice(0, 120)
            );
          return picked;
        }
        const text = await deps.judge(
          {
            ...discussNextPrompt(input),
            preferred: current?.model,
            timeoutMs: current?.timeoutMs ?? SMART_ROUTE_DEFAULT_TIMEOUT_MS,
            maxTokens: DISCUSS_JUDGE_MAX_TOKENS,
          },
          signal
        );
        if (text === null) return { failure: '判断模型不可用' };
        const decision = parseDiscussNext(text, input);
        if (!decision)
          console.warn('[bots] discuss judge reply not understood:', text.slice(0, 80));
        return decision ?? { failure: '判断结果无法识别' };
      } catch (error) {
        if (signal.aborted) return { end: true };
        console.warn('[bots] discuss judge failed', error);
        return { failure: briefErrorReason(error) };
      }
    },
  };
}
