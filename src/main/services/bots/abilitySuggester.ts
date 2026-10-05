import {
  type AbilitySuggestInput,
  abilitySuggestPrompt,
  parseAbilitySuggestion,
} from '../../../shared/bots/abilitySuggest';
import {
  type GoalSuggestInput,
  goalSuggestPrompt,
  parseGoalSuggestion,
} from '../../../shared/bots/goalSuggest';
import {
  type PersonaSuggestInput,
  parsePersonaSuggestion,
  personaSuggestPrompt,
} from '../../../shared/bots/personaSuggest';
import type {
  BotAbilitySuggestResult,
  BotGoalSuggestResult,
  BotPersonaSuggestResult,
} from '../../../shared/types/botIpc';

export const ABILITY_SUGGEST_TIMEOUT_MS = 20_000;
export const PERSONA_SUGGEST_TIMEOUT_MS = 30_000;
export const GOAL_SUGGEST_TIMEOUT_MS = 45_000;

/** 便宜模型一次性补全；没有可用模型返回 null */
export type AbilityCompleter = (
  request: { systemPrompt: string; userText: string; timeoutMs: number },
  signal: AbortSignal
) => Promise<string | null>;

type Failure = { ok: false; error: string; detail?: string };

/** 一次补全 + 超时 + 解析；解析失败报 invalid-reply */
async function runSuggest<T>(
  prompt: { systemPrompt: string; userText: string },
  parse: (text: string) => T | null,
  complete: AbilityCompleter,
  timeoutMs: number
): Promise<{ ok: true; suggestion: T } | Failure> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('timeout');
    }, timeoutMs);
  });
  try {
    const text = await Promise.race([
      complete({ ...prompt, timeoutMs }, controller.signal),
      timeout,
    ]);
    if (text === 'timeout') return { ok: false, error: 'timeout' };
    if (text === null) return { ok: false, error: 'no-model' };
    const suggestion = parse(text);
    if (!suggestion) {
      console.warn('[bots] suggestion not understood:', text.slice(0, 120));
      return { ok: false, error: 'invalid-reply' };
    }
    return { ok: true, suggestion };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, error: 'timeout' };
    return {
      ok: false,
      error: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function suggestAbilities(
  input: AbilitySuggestInput,
  complete: AbilityCompleter,
  timeoutMs = ABILITY_SUGGEST_TIMEOUT_MS
): Promise<BotAbilitySuggestResult> {
  return runSuggest(
    abilitySuggestPrompt(input),
    (text) => parseAbilitySuggestion(text, input),
    complete,
    timeoutMs
  ) as Promise<BotAbilitySuggestResult>;
}

export function suggestPersona(
  input: PersonaSuggestInput,
  complete: AbilityCompleter,
  timeoutMs = PERSONA_SUGGEST_TIMEOUT_MS
): Promise<BotPersonaSuggestResult> {
  return runSuggest(
    personaSuggestPrompt(input),
    (text) => parsePersonaSuggestion(text, input),
    complete,
    timeoutMs
  ) as Promise<BotPersonaSuggestResult>;
}

export function suggestGoal(
  input: GoalSuggestInput,
  complete: AbilityCompleter,
  timeoutMs = GOAL_SUGGEST_TIMEOUT_MS
): Promise<BotGoalSuggestResult> {
  return runSuggest(
    goalSuggestPrompt(input),
    (text) => parseGoalSuggestion(text, input),
    complete,
    timeoutMs
  ) as Promise<BotGoalSuggestResult>;
}
