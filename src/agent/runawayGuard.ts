import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { prependToolText, toolResultIsError, toolResultText } from './systemReminder';

export type RunawaySignal =
  | 'exact_action_repeat'
  | 'same_error_family'
  | 'polling_repeat'
  | 'unchanged_progress_repeat';

const THRESHOLD = 3;
/** 提醒之后同一信号继续累积到此即终止本轮 */
const STOP_THRESHOLD = 6;

export interface RunawayVerdict {
  text: string;
  /** true：结果带 terminate，pi 在本批工具后结束本轮 */
  stop: boolean;
}

interface Streak {
  key: string;
  count: number;
}

function bump(streak: Streak, key: string): Streak {
  if (!key) return { key: '', count: 0 };
  return key === streak.key ? { key, count: streak.count + 1 } : { key, count: 1 };
}

function fingerprint(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, nested) => {
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        return Object.fromEntries(
          Object.keys(nested as Record<string, unknown>)
            .sort()
            .map((key) => [key, (nested as Record<string, unknown>)[key]])
        );
      }
      return nested;
    }).slice(0, 4096);
  } catch {
    return '';
  }
}

function errorFamily(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.slice(0, 80) || 'error';
}

export function runawayReminderText(kind: RunawaySignal): string {
  const guidance =
    kind === 'polling_repeat'
      ? 'Three task_output reads for the same task have returned an unchanged status and output cursor. Avoid repeated polling; you will be notified automatically and this conversation will resume when the background task completes.'
      : kind === 'same_error_family'
        ? `[runaway guard] The same error family has now occurred ${THRESHOLD} times. Do not retry the identical failing action. Inspect the error, change the approach, or stop.`
        : kind === 'unchanged_progress_repeat'
          ? `[runaway guard] ${THRESHOLD} consecutive tool results made no observable progress. Stop repeating the same step; inspect what you already have and change approach.`
          : `[runaway guard] The immediately repeated tool action has now occurred ${THRESHOLD} times with the same arguments and the same result. Do not repeat it unchanged. Inspect the results already returned and take a different next step.`;
  return (
    `<system-reminder>\n${guidance}\n` +
    'This reminder applies only to the current Turn. Do not save or generalize it into Memory, Skills, or other persistent instructions.\n' +
    '</system-reminder>'
  );
}

export function runawayStopText(kind: RunawaySignal, count: number): string {
  const what =
    kind === 'polling_repeat'
      ? 'task_output reads returned an unchanged status'
      : kind === 'same_error_family'
        ? 'tool calls failed with the same error'
        : 'tool calls produced no observable progress';
  return (
    `<system-reminder>\n[runaway guard] Stopped this turn: ${count} consecutive ${what}. ` +
    'Do not resume the same loop. When the user writes again, summarize what was tried and propose a different approach.\n' +
    'Do not save or generalize this into Memory, Skills, or other persistent instructions.\n' +
    '</system-reminder>'
  );
}

export class RunawayGuard {
  private action: Streak = { key: '', count: 0 };
  private result: Streak = { key: '', count: 0 };
  private error: Streak = { key: '', count: 0 };
  private poll: Streak = { key: '', count: 0 };
  private reminded = false;

  resetTurn(): void {
    this.action = { key: '', count: 0 };
    this.result = { key: '', count: 0 };
    this.error = { key: '', count: 0 };
    this.poll = { key: '', count: 0 };
    this.reminded = false;
  }

  observe(
    toolName: string,
    args: unknown,
    result: { text: string; isError?: boolean }
  ): RunawayVerdict | undefined {
    const record =
      args && typeof args === 'object' && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    const polling = toolName === 'task_output';
    if (polling) {
      const taskId = String(record.taskId ?? '');
      this.poll = bump(this.poll, `${taskId}\0${fingerprint(result.text)}`);
      this.action = { key: '', count: 0 };
      this.result = { key: '', count: 0 };
    } else if (toolName === 'computer') {
      this.action = { key: '', count: 0 };
      this.result = result.isError
        ? { key: '', count: 0 }
        : bump(this.result, fingerprint(result.text));
      this.poll = { key: '', count: 0 };
    } else {
      // 判重带结果：同参数但结果在变（轮询构建状态）不是卡死
      const outcome = result.isError
        ? `e\0${errorFamily(result.text)}`
        : `o\0${fingerprint(result.text)}`;
      this.action = bump(this.action, `${toolName}\0${fingerprint(args)}\0${outcome}`);
      this.result = result.isError
        ? { key: '', count: 0 }
        : bump(this.result, `${toolName}\0${fingerprint(result.text)}`);
      this.poll = { key: '', count: 0 };
    }
    this.error = result.isError
      ? bump(this.error, `${toolName}\0${errorFamily(result.text)}`)
      : { key: '', count: 0 };

    const signals: Array<[RunawaySignal, number]> = [
      ['unchanged_progress_repeat', this.result.count],
      ['same_error_family', this.error.count],
      ['exact_action_repeat', this.action.count],
      ['polling_repeat', this.poll.count],
    ];
    const hit = signals.find(([, count]) => count >= THRESHOLD);
    if (!hit) return undefined;
    const [kind, count] = hit;
    // task_output 阻塞等待每次最多 30s，不再单独放宽：完成会自动唤醒，反复等待就是轮询
    if (count >= STOP_THRESHOLD) {
      return { text: runawayStopText(kind, count), stop: true };
    }
    if (this.reminded) return undefined;
    this.reminded = true;
    return { text: runawayReminderText(kind), stop: false };
  }
}

export function withRunawayGuard(definition: ToolDefinition, guard: RunawayGuard): ToolDefinition {
  return {
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = await definition.execute(toolCallId, params, signal, onUpdate, ctx);
      const verdict = guard.observe(definition.name, params, {
        text: toolResultText(result),
        isError: toolResultIsError(result),
      });
      if (!verdict) return result;
      const marked = prependToolText(result, verdict.text);
      return verdict.stop ? { ...marked, terminate: true } : marked;
    },
  };
}
