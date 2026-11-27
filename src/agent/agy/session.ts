import { readFileSync, realpathSync } from 'node:fs';
import { modelsFromSessionResult, modelToSet, nearestThinking } from '@shared/agy/catalog';
import { fsReadAllowed } from '@shared/agy/fsAllow';
import { decidePermission, permissionOutcome, sessionModeFor } from '@shared/agy/permission';
import {
  buildAgyPrompt,
  runtimeInfoText,
  trailingUserTexts,
  userText,
} from '@shared/agy/promptBuilder';
import { initialAgySession, transitionAgySession } from '@shared/agy/sessionPhase';
import {
  emptyTranslatorState,
  holdsTurn,
  reduceAgyUpdate,
  stopFromPrompt,
} from '@shared/agy/translator';
import {
  FLOW_TIMER_MS,
  type FlowEvent,
  initialTurnFlow,
  stepTurnFlow,
  type TurnFlow,
} from '@shared/agy/turnFlow';
import type {
  AgyInteractionMode,
  AgyPermissionRequest,
  AgySessionPhase,
  PermissionResponse,
  PiStopReason,
  PromptMessage,
  TranslatorEffect,
  TranslatorState,
  UserPermissionDecision,
} from '@shared/agy/types';
import { agyVersionAtLeast } from '@shared/agy/version';
import type { ApprovalMode } from '@shared/types/agentConstants';
import { AgyRpcError } from './connection';
import type { AcpHttpMcpServer, HostMcpGrant } from './hostMcp';
import { startAgyProcess } from './process';
import {
  type AgyTurnUsage,
  agyTurnUsage,
  configValue,
  parseInitialize,
  parsePermissionRequest,
  parseSessionSetup,
  thinkingValues,
} from './protocol';

const CANCEL_GRACE_MS = 5_000;
/** agy 从这一版起把轮中的第二个 session/prompt 当插话（t3 PROMPT_STEERING_RELEASE） */
const PROMPT_STEERING_RELEASE = '1.5.0';

export interface AgyTurnInput {
  messages: readonly PromptMessage[];
  planMode: boolean;
  approvalMode: ApprovalMode;
  workspaceRoot: string;
  modelId: string;
  thinkingLevel: string;
  modelLabel: string;
  /** 本轮 pi 系统提示词里的 EnsoCode 自有段（见 ensoSystemAppend）；和 agy 已有的不同时随指令重发 */
  systemAppend?: string;
  signal?: AbortSignal;
  ask: (request: AgyPermissionRequest, signal: AbortSignal) => Promise<UserPermissionDecision>;
  onEvent?: (event: TranslatorEffect) => void;
}

export interface AgyTurnResult {
  stopReason: PiStopReason;
  text: string;
  thinking: string;
  tools: TranslatorState['tools'];
  sessionId: string;
  usage: AgyTurnUsage;
}

export interface AgySession {
  phase(): AgySessionPhase;
  sessionId(): string | undefined;
  resumed: boolean;
  /** 挂到 Host MCP 上的 Enso 工具名；agy 不支持 HTTP MCP 或没有可挂的工具时为空 */
  ensoTools: readonly string[];
  turn(input: AgyTurnInput): Promise<AgyTurnResult>;
  /**
   * 轮中插话：本轮还在流时，把这条 user 消息原样作为新的 session/prompt 发给 agy（不取消重来）。
   * 返回 false 表示没有在跑的轮或 agy 太旧，调用方照常排到下一轮。pi 随后送来这条消息时，
   * `turn()` 认出它并接上已经在流的回答，不再发 prompt。
   */
  steer(messages: readonly PromptMessage[]): boolean;
  close(): Promise<void>;
}

/** 会话打开时的 Host MCP：要挂的工具名快照，和发 bearer 的入口（只在 agy 接得住时才调用）。 */
export interface AgyHostMcp {
  tools: readonly string[];
  issue(): Promise<HostMcpGrant>;
}

/** pi 这一轮在等哪段回复：事件、权限询问、取消都走它 */
interface Sink {
  signal?: AbortSignal;
  ask: AgyTurnInput['ask'];
  onEvent?: AgyTurnInput['onEvent'];
  approvalMode: ApprovalMode;
  workspaceRoot: string;
}

/**
 * 一次 session/prompt 在 Enso 里对应的那段回复（一条 assistant）。agy 的 update 不带 prompt 标识，
 * 按顺序归给最早一段还没收尾的；收尾时机由 turnFlow 决定。插话发出的段在 pi 接上之前先缓存事件。
 */
interface Segment {
  /** 插话发出的段：pi 随后送来的 user 消息文字以它开头 */
  steerText?: string;
  flow: TurnFlow;
  state: TranslatorState;
  sink?: Sink;
  buffered: TranslatorEffect[];
  sinkWaiters: Array<(sink: Sink | undefined) => void>;
  response?: unknown;
  error?: unknown;
  aborted: boolean;
  timer?: ReturnType<typeof setTimeout>;
  done: Promise<void>;
  finish: () => void;
}

export async function openAgySession(options: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  clientVersion: string;
  readRoots: readonly string[];
  resumeSessionId?: string;
  hostMcp?: AgyHostMcp;
  /** EnsoCode 自有系统提示词段：agy 通告能 append 时放进 session/new、session/resume 的 _meta */
  systemAppend?: string;
  timeoutMs?: number;
}): Promise<AgySession> {
  const cwd = realpathSync(options.cwd);
  const proc = startAgyProcess({
    command: options.command,
    args: options.args,
    cwd,
    env: options.env ?? process.env,
  });
  let phase = transitionAgySession(initialAgySession(), { type: 'spawn' });
  let segments: Segment[] = [];
  const served: string[] = [];
  let sentMode: AgyInteractionMode | undefined;
  let sentRuntime: string | undefined;
  /** agy 这个会话已经拿到的 append：session 级 _meta 或某轮指令里发过的 */
  let sentAppend: string | undefined;
  let resumed = false;
  let grant: HostMcpGrant | undefined;
  let ensoTools: readonly string[] = [];
  let steerable = false;
  const timeout = options.timeoutMs ?? 15_000;

  const fail = (message: string) => {
    phase = transitionAgySession(phase, { type: 'fail', message });
  };
  const owner = () => segments.find((segment) => !segment.flow.closed);

  const finish = (segment: Segment) => {
    if (segment.timer) clearTimeout(segment.timer);
    segment.timer = undefined;
    if (!segment.flow.closed) segment.flow = { ...segment.flow, closed: true };
    for (const waiter of segment.sinkWaiters.splice(0)) waiter(segment.sink);
    segment.finish();
  };
  const step = (segment: Segment, event: FlowEvent) => {
    // 已中止的段只等 agy 回 cancelled 或宽限期满，不再按流程挂计时器
    if (segment.aborted) return;
    const next = stepTurnFlow(segment.flow, event);
    segment.flow = next.flow;
    if (segment.timer) clearTimeout(segment.timer);
    segment.timer = undefined;
    if (next.flow.closed) {
      finish(segment);
      return;
    }
    if (next.timer === 'none') return;
    segment.timer = setTimeout(() => step(segment, { type: 'quiet' }), FLOW_TIMER_MS[next.timer]);
  };
  const newSegment = (steerText?: string): Segment => {
    let resolve: () => void = () => {};
    const done = new Promise<void>((settle) => {
      resolve = settle;
    });
    return {
      ...(steerText !== undefined ? { steerText } : {}),
      flow: initialTurnFlow(),
      state: emptyTranslatorState(),
      buffered: [],
      sinkWaiters: [],
      aborted: false,
      done,
      finish: resolve,
    };
  };
  const attach = (segment: Segment, sink: Sink) => {
    segment.sink = sink;
    for (const effect of segment.buffered.splice(0)) sink.onEvent?.(effect);
    for (const waiter of segment.sinkWaiters.splice(0)) waiter(sink);
  };
  const sendPrompt = (segment: Segment, sessionId: string, prompt: unknown) => {
    // 答复和 update 必须按线上顺序处理：被插话的段要在答复之后的第一个 usage_update 收尾
    proc.rpc.requestInOrder('session/prompt', { sessionId, prompt }, (outcome) => {
      if ('error' in outcome) {
        segment.error = outcome.error;
        finish(segment);
        return;
      }
      const result = outcome.result;
      segment.response = result;
      // 后发的 prompt 都返回了，前面的段不会再有输出
      for (const earlier of segments.slice(0, segments.indexOf(segment))) finish(earlier);
      if (segment.aborted) {
        finish(segment);
        return;
      }
      step(segment, {
        type: 'response',
        stopReason: record(result)?.stopReason,
        withUsage: record(record(result)?.usage) !== undefined,
        background: holdsTurn(segment.state.tools),
      });
    });
  };
  /** Stop：只有用户中止才发 session/cancel；已返回的段立刻收尾，没返回的等 agy 回 cancelled 或宽限期满 */
  const abortAll = (sessionId: string) => {
    proc.rpc.notify('session/cancel', { sessionId });
    for (const segment of segments) {
      if (segment.flow.closed) continue;
      segment.aborted = true;
      if (segment.response !== undefined) finish(segment);
      else segment.timer = setTimeout(() => finish(segment), CANCEL_GRACE_MS);
    }
  };
  const settleIdle = () => {
    if (phase.phase === 'prompting' && !segments.some((segment) => !segment.flow.closed)) {
      phase = transitionAgySession(phase, { type: 'prompt-finished' });
    }
  };
  const release = (done: readonly Segment[]) => {
    segments = segments.filter((segment) => !done.includes(segment));
    settleIdle();
  };

  let setupState: SetupState | undefined;
  proc.rpc.setNotificationHandler((method, params) => {
    if (method !== 'session/update') return;
    const update = record(params)?.update;
    if (setupState) noteConfigUpdate(setupState, update);
    const segment = owner();
    if (!segment) return;
    const reduced = reduceAgyUpdate(segment.state, update, served);
    segment.state = reduced.state;
    for (const effect of reduced.effects) {
      if (segment.sink) segment.sink.onEvent?.(effect);
      else segment.buffered.push(effect);
    }
    const kind = record(update)?.sessionUpdate;
    if (typeof kind === 'string') {
      step(segment, { type: 'update', kind, background: holdsTurn(segment.state.tools) });
    }
  });
  proc.rpc.setRequestHandler(async (method, params) => {
    if (method === 'fs/read_text_file') return readAllowed(params, options.readRoots, served);
    if (method === 'session/request_permission' || method === 'request_permission') {
      return answerPermission(params, await sinkFor(owner()), ensoTools);
    }
    throw new AgyRpcError(-32601, method);
  });
  /** 插话段在 pi 接上前就可能来权限请求：等它接上；段被丢掉或收尾了就当取消 */
  const sinkFor = (segment: Segment | undefined): Promise<Sink | undefined> => {
    if (!segment) return Promise.resolve(undefined);
    if (segment.sink || segment.flow.closed) return Promise.resolve(segment.sink);
    return new Promise((resolve) => segment.sinkWaiters.push(resolve));
  };

  try {
    const init = await proc.rpc.request(
      'initialize',
      initializeParams(options.clientVersion),
      AbortSignal.timeout(timeout)
    );
    const parsedInit = parseInitialize(init);
    if (!parsedInit) throw new Error('agy initialize returned no version');
    steerable = agyVersionAtLeast(parsedInit.version, PROMPT_STEERING_RELEASE);
    phase = transitionAgySession(phase, {
      type: 'initialized',
      version: parsedInit.version,
      canAppendSystemPrompt: parsedInit.canAppendSystemPrompt,
    });
    const hostMcp = options.hostMcp;
    if (parsedInit.httpMcp && hostMcp && hostMcp.tools.length > 0) {
      grant = await hostMcp.issue();
      ensoTools = [...hostMcp.tools];
    }
    const append = options.systemAppend?.trim() ?? '';
    const meta =
      parsedInit.canAppendSystemPrompt && append
        ? { antigravity: { systemPrompt: { append } } }
        : undefined;
    const opened = await openProtocolSession(
      proc.rpc,
      cwd,
      options.resumeSessionId,
      timeout,
      grant ? [grant.server] : [],
      meta
    );
    resumed = opened.resumed;
    if (meta) sentAppend = append;
    const setup = parseSessionSetup(opened.result);
    if (!setup) throw new Error('agy session returned no sessionId');
    phase = transitionAgySession(phase, {
      type: 'session-ready',
      sessionId: setup.sessionId,
      version: parsedInit.version,
      canAppendSystemPrompt: parsedInit.canAppendSystemPrompt,
      configOptions: setup.configOptions,
      modes: setup.modes,
    });
    setupState = {
      ...setup,
      version: parsedInit.version,
      canAppendSystemPrompt: parsedInit.canAppendSystemPrompt,
    };
    const state: SetupState = setupState;
    const sessionId = setup.sessionId;

    /** pi 接上若干段（一段新 prompt，或之前插话发出的几段），等它们都收尾 */
    const follow = async (
      taken: Segment[],
      input: AgyTurnInput,
      onResponse?: () => void
    ): Promise<AgyTurnResult> => {
      const sink: Sink = {
        signal: input.signal,
        ask: input.ask,
        onEvent: input.onEvent,
        approvalMode: input.approvalMode,
        workspaceRoot: input.workspaceRoot,
      };
      const onAbort = () => abortAll(sessionId);
      input.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        for (const segment of taken) attach(segment, sink);
        if (input.signal?.aborted) onAbort();
        await Promise.all(taken.map((segment) => segment.done));
        const aborted = input.signal?.aborted === true || taken.some((segment) => segment.aborted);
        const failed = taken.find((segment) => segment.error !== undefined);
        if (failed && !aborted) {
          const error = failed.error;
          fail(error instanceof Error ? error.message : String(error));
          throw error;
        }
        if (!aborted) onResponse?.();
        return combine(taken, sessionId, aborted);
      } finally {
        input.signal?.removeEventListener('abort', onAbort);
        release(taken);
      }
    };

    return {
      phase: () => phase,
      sessionId: () =>
        phase.phase === 'session-ready' || phase.phase === 'prompting'
          ? phase.sessionId
          : undefined,
      resumed,
      ensoTools,
      async turn(input) {
        const adopted = adoptSteered(segments, input.messages);
        if (adopted.length > 0) return follow(adopted, input);
        // 没被 pi 送进上下文的插话段（比如被撤回）不再等，也不再收它们的输出
        const orphans = segments.filter((segment) => !segment.sink);
        for (const segment of orphans) finish(segment);
        release(orphans);
        if (phase.phase !== 'session-ready') throw new Error(`agy session is ${phase.phase}`);
        phase = transitionAgySession(phase, { type: 'prompt-started' });
        const flags = instructionFlags(input, sentMode, sentRuntime, sentAppend);
        const blocks = buildAgyPrompt({
          messages: input.messages,
          interactionMode: flags.mode,
          includeInstructions: flags.includeInstructions,
          includeRuntimeInfo: flags.includeRuntimeInfo,
          modelLabel: input.modelLabel,
          ensoTools,
          ...(flags.includeAppend ? { systemAppend: flags.append } : {}),
        });
        try {
          await alignSession(proc.rpc, sessionId, state, input);
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
          throw error;
        }
        if (input.signal?.aborted) {
          proc.rpc.notify('session/cancel', { sessionId });
          phase = transitionAgySession(phase, { type: 'prompt-finished' });
          return emptyTurn(sessionId, 'aborted');
        }
        const segment = newSegment();
        segments.push(segment);
        sendPrompt(segment, sessionId, blocks);
        return follow([segment], input, () => {
          if (slashCommand(input.messages)) return;
          if (flags.includeInstructions) sentMode = flags.mode;
          if (flags.includeRuntimeInfo) sentRuntime = flags.runtime;
          if (flags.includeAppend) sentAppend = flags.append;
        });
      },
      steer(messages) {
        if (!steerable || phase.phase !== 'prompting') return false;
        const latest = segments
          .filter((segment) => !segment.flow.closed && !segment.aborted)
          .at(-1);
        if (!latest) return false;
        const blocks = buildAgyPrompt({
          messages,
          interactionMode: 'default',
          includeInstructions: false,
          includeRuntimeInfo: false,
          modelLabel: '',
        });
        if (blocks.length === 0) return false;
        const segment = newSegment(userText(messages.at(-1)));
        segments.push(segment);
        step(latest, { type: 'steer' });
        sendPrompt(segment, sessionId, blocks);
        return true;
      },
      close: async () => {
        grant?.revoke();
        for (const segment of segments) {
          segment.aborted = true;
          finish(segment);
        }
        phase = transitionAgySession(phase, { type: 'close' });
        await proc.kill();
      },
    };
  } catch (error) {
    grant?.revoke();
    fail(error instanceof Error ? error.message : String(error));
    await proc.kill();
    throw error;
  }
}

/** pi 在这个边界送进来的 user 消息里，按顺序认出之前插话发出、还没人接的段 */
function adoptSteered(segments: readonly Segment[], messages: readonly PromptMessage[]): Segment[] {
  const queued = segments.filter(
    (segment) => segment.steerText !== undefined && !segment.sink && !segment.aborted
  );
  const adopted: Segment[] = [];
  for (const text of trailingUserTexts(messages)) {
    const next = queued[adopted.length];
    if (next?.steerText !== undefined && text.startsWith(next.steerText)) adopted.push(next);
  }
  return adopted;
}

function combine(taken: readonly Segment[], sessionId: string, aborted: boolean): AgyTurnResult {
  const last = taken.at(-1);
  // 占用取这几段里最后一个 usage_update，不把各段的 PromptResponse.usage 相加
  const context = taken.findLast((segment) => segment.state.context)?.state.context;
  return {
    stopReason: aborted ? 'aborted' : stopFromPrompt(record(last?.response)?.stopReason),
    text: taken.map((segment) => segment.state.text).join(''),
    thinking: taken.map((segment) => segment.state.thinking).join(''),
    tools: taken.flatMap((segment) => segment.state.tools),
    sessionId,
    usage: agyTurnUsage(
      context,
      taken.map((segment) => segment.response)
    ),
  };
}

function initializeParams(version: string) {
  return {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: 'enso-code', title: 'EnsoCode', version },
  };
}

async function openProtocolSession(
  rpc: ReturnType<typeof startAgyProcess>['rpc'],
  cwd: string,
  resumeSessionId: string | undefined,
  timeoutMs: number,
  mcpServers: AcpHttpMcpServer[],
  meta: Record<string, unknown> | undefined
) {
  const signal = AbortSignal.timeout(timeoutMs);
  const extra = meta ? { _meta: meta } : {};
  if (!resumeSessionId) {
    return {
      resumed: false,
      result: await rpc.request('session/new', { cwd, mcpServers, ...extra }, signal),
    };
  }
  try {
    return {
      resumed: true,
      result: await rpc.request(
        'session/resume',
        { sessionId: resumeSessionId, cwd, mcpServers, ...extra },
        signal
      ),
    };
  } catch (error) {
    if (error instanceof AgyRpcError && (error.code === -32000 || error.code === -32603))
      throw error;
    return {
      resumed: false,
      result: await rpc.request('session/new', { cwd, mcpServers, ...extra }, signal),
    };
  }
}

type SetupState = NonNullable<ReturnType<typeof parseSessionSetup>> & {
  version: string;
  canAppendSystemPrompt: boolean;
};

/** set_config_option 的答复和 config_option_update 都带全量 configOptions：记下来，下一轮不重发。 */
function noteConfigOptions(setup: SetupState, value: unknown) {
  const parsed = parseSessionSetup({
    sessionId: setup.sessionId,
    configOptions: record(value)?.configOptions,
  });
  if (parsed && parsed.configOptions.length > 0) setup.configOptions = parsed.configOptions;
}

function noteConfigUpdate(setup: SetupState, update: unknown) {
  const row = record(update);
  if (row?.sessionUpdate === 'config_option_update') noteConfigOptions(setup, row);
  if (row?.sessionUpdate === 'current_mode_update' && typeof row.currentModeId === 'string') {
    setup.currentModeId = row.currentModeId;
  }
}

async function alignSession(
  rpc: ReturnType<typeof startAgyProcess>['rpc'],
  sessionId: string,
  setup: SetupState,
  input: AgyTurnInput
) {
  const setOption = async (configId: string, value: string) => {
    noteConfigOptions(
      setup,
      await rpc.request('session/set_config_option', { sessionId, configId, value })
    );
  };
  const model = modelToSet(input.modelId, modelsFromSessionResult(setup));
  if (model && model !== configValue(setup.configOptions, 'model')) await setOption('model', model);
  const thinking = nearestThinking(input.thinkingLevel, thinkingValues(setup.configOptions));
  if (thinking && thinking !== configValue(setup.configOptions, 'thought_level')) {
    await setOption('thought_level', thinking);
  }
  const mode = sessionModeFor(input.planMode);
  const current = configValue(setup.configOptions, 'mode') ?? setup.currentModeId ?? 'default';
  if (current === mode) return;
  try {
    noteConfigOptions(setup, await rpc.request('session/set_mode', { sessionId, modeId: mode }));
  } catch (error) {
    if (!(error instanceof AgyRpcError) || error.code !== -32601) throw error;
    await setOption('mode', mode);
  }
  setup.currentModeId = mode;
}

function instructionFlags(
  input: AgyTurnInput,
  sentMode: AgyInteractionMode | undefined,
  sentRuntime: string | undefined,
  sentAppend: string | undefined
) {
  const mode: AgyInteractionMode = input.planMode ? 'plan' : 'default';
  const runtime = runtimeInfoText(input.modelLabel);
  const append = input.systemAppend?.trim() ?? '';
  // 能 append 的 agy 在 session 级就有了；没给过或中途变了（预设、插件尾段），随下一轮指令发一次
  const includeAppend = append !== '' && append !== sentAppend;
  return {
    mode,
    runtime,
    append,
    includeAppend,
    includeInstructions: sentMode !== mode || includeAppend,
    includeRuntimeInfo: sentRuntime !== runtime,
  };
}

function slashCommand(messages: readonly PromptMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    const text = typeof message.content === 'string' ? message.content : '';
    return text.trimStart().startsWith('/');
  }
  return false;
}

function readAllowed(params: unknown, roots: readonly string[], served: string[]) {
  const row = record(params);
  const target = typeof row?.path === 'string' ? row.path : '';
  if (!fsReadAllowed(target, roots)) throw new AgyRpcError(-32602, 'path not allowed');
  const line = typeof row?.line === 'number' ? row.line : undefined;
  const limit = typeof row?.limit === 'number' ? row.limit : undefined;
  const content = sliceText(readFileSync(target, 'utf8'), line, limit);
  served.push(target);
  return { content };
}

function sliceText(text: string, line: number | undefined, limit: number | undefined): string {
  if (line === undefined && limit === undefined) return text;
  const lines = text.split('\n');
  const start = Math.max(0, (line ?? 1) - 1);
  const end = limit === undefined ? lines.length : start + limit;
  return lines.slice(start, end).join('\n');
}

async function answerPermission(
  params: unknown,
  active: Sink | undefined,
  ensoTools: readonly string[]
) {
  const request = parsePermissionRequest(params);
  if (!request || !active) return wire({ outcome: 'cancelled' });
  const decided = decidePermission({
    approvalMode: active.approvalMode,
    request,
    workspaceRoot: active.workspaceRoot,
    ensoTools,
  });
  if (decided.kind === 'selected') return wire({ outcome: 'selected', optionId: decided.optionId });
  const signal = active.signal ?? new AbortController().signal;
  const decision = await active.ask(request, signal);
  return wire(permissionOutcome(decision, request.options));
}

function wire(response: PermissionResponse) {
  if (response.outcome === 'cancelled') return { outcome: { outcome: 'cancelled' } };
  return { outcome: { outcome: 'selected', optionId: response.optionId } };
}

function emptyTurn(
  sessionId: string,
  stopReason: PiStopReason,
  state: TranslatorState = emptyTranslatorState()
): AgyTurnResult {
  return {
    stopReason,
    text: state.text,
    thinking: state.thinking,
    tools: state.tools,
    sessionId,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
