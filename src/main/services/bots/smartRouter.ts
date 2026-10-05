import {
  addressesEveryone,
  decideSmartRoute,
  guessSmartRouteIntent,
  parseSmartRouteIntent,
  parseSmartRouteReply,
  pickSmartRouteChoice,
  pickSmartRouteIntent,
  rankSmartRouteChoice,
  type SmartRouteInput,
  smartRouteIntentQuestion,
  smartRouteJudgePrompt,
  smartRouteQuestion,
} from '../../../shared/bots/smartRoute';
import type { DefaultModelRef } from '../../../shared/defaultModel';
import {
  parseVirtualClassifier,
  VIRTUAL_CLASSIFIER_DEFAULT_TIMEOUT_MS,
  type VirtualClassifierConfig,
} from '../../../shared/virtualModels';
import type { GroupResponderSelector } from './groupChat';

interface SmartRouterDeps {
  settings: () => Record<string, unknown> | undefined;
  /** 便宜模型一次性补全：preferred 排最前，其后是标题模型回退链；没有可用模型返回 null */
  judge: (
    request: {
      systemPrompt: string;
      userText: string;
      preferred: DefaultModelRef | undefined;
      timeoutMs: number;
    },
    signal: AbortSignal
  ) => Promise<string | null>;
  /** pi 分类器 choice 问题；分类器不可用返回 null */
  classify: (
    config: VirtualClassifierConfig,
    question: ReturnType<typeof smartRouteQuestion> | ReturnType<typeof smartRouteIntentQuestion>,
    signal: AbortSignal
  ) => Promise<Record<string, number> | null>;
}

/**
 * 全局「群聊选人模型」：未设置走 judge + 标题模型回退链；judge 指定快模型；pi-classifier 走 worker 分类
 * （成员与意图各问一次）。判不出意图时用关键词兜底。
 */
export function createSmartRouter(deps: SmartRouterDeps): GroupResponderSelector {
  const config = () => parseVirtualClassifier(deps.settings()?.botRouteClassifier);
  return {
    timeoutMs: () => config()?.timeoutMs ?? VIRTUAL_CLASSIFIER_DEFAULT_TIMEOUT_MS,
    async select(input: SmartRouteInput, signal: AbortSignal) {
      // 点名全员时规则直出，不受模型挑人上限与置信度影响
      if (addressesEveryone(input.message))
        return { ids: input.candidates.map((candidate) => candidate.id) };
      const current = config();
      if (current?.source === 'pi-classifier') {
        const [probabilities, intents] = await Promise.all([
          deps.classify(current, smartRouteQuestion(input), signal),
          Promise.resolve()
            .then(() => deps.classify(current, smartRouteIntentQuestion(input), signal))
            .catch(() => null),
        ]);
        if (!probabilities) {
          console.warn('[bots] smart routing: classifier unavailable');
          return { ids: [] };
        }
        return decideSmartRoute(
          input,
          pickSmartRouteIntent(intents) ?? guessSmartRouteIntent(input.message),
          pickSmartRouteChoice(probabilities, input),
          rankSmartRouteChoice(probabilities, input)
        );
      }
      const text = await deps.judge(
        {
          ...smartRouteJudgePrompt(input),
          preferred: current?.model,
          timeoutMs: current?.timeoutMs ?? VIRTUAL_CLASSIFIER_DEFAULT_TIMEOUT_MS,
        },
        signal
      );
      if (text === null) {
        console.warn('[bots] smart routing: no model available');
        return { ids: [] };
      }
      const picked = parseSmartRouteReply(text, input);
      if (picked.length === 0)
        console.warn('[bots] smart routing reply not understood:', text.slice(0, 80));
      return decideSmartRoute(
        input,
        parseSmartRouteIntent(text) ?? guessSmartRouteIntent(input.message),
        picked
      );
    },
  };
}
