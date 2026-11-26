import { readFileSync, realpathSync } from 'node:fs';
import { modelsFromSessionResult, modelToSet, nearestThinking } from '@shared/agy/catalog';
import { fsReadAllowed } from '@shared/agy/fsAllow';
import { decidePermission, permissionOutcome, sessionModeFor } from '@shared/agy/permission';
import { buildAgyPrompt, runtimeInfoText } from '@shared/agy/promptBuilder';
import { initialAgySession, transitionAgySession } from '@shared/agy/sessionPhase';
import { emptyTranslatorState, reduceAgyUpdate, stopFromPrompt } from '@shared/agy/translator';
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
import type { ApprovalMode } from '@shared/types/agentConstants';
import { AgyRpcError } from './connection';
import type { AcpHttpMcpServer, HostMcpGrant } from './hostMcp';
import { startAgyProcess } from './process';
import {
  configValue,
  parseInitialize,
  parsePermissionRequest,
  parseSessionSetup,
  thinkingValues,
  usageFromPrompt,
} from './protocol';

const CANCEL_GRACE_MS = 5_000;

export interface AgyTurnInput {
  messages: readonly PromptMessage[];
  planMode: boolean;
  approvalMode: ApprovalMode;
  workspaceRoot: string;
  modelId: string;
  thinkingLevel: string;
  modelLabel: string;
  compressed?: boolean;
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
  usage: ReturnType<typeof usageFromPrompt>;
}

export interface AgySession {
  phase(): AgySessionPhase;
  sessionId(): string | undefined;
  resumed: boolean;
  /** 挂到 Host MCP 上的 Enso 工具名；agy 不支持 HTTP MCP 或没有可挂的工具时为空 */
  ensoTools: readonly string[];
  turn(input: AgyTurnInput): Promise<AgyTurnResult>;
  close(): Promise<void>;
}

/** 会话打开时的 Host MCP：要挂的工具名快照，和发 bearer 的入口（只在 agy 接得住时才调用）。 */
export interface AgyHostMcp {
  tools: readonly string[];
  issue(): Promise<HostMcpGrant>;
}

interface ActiveTurn {
  signal?: AbortSignal;
  ask: AgyTurnInput['ask'];
  served: string[];
  state: TranslatorState;
  onEvent?: AgyTurnInput['onEvent'];
  approvalMode: ApprovalMode;
  workspaceRoot: string;
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
  let active: ActiveTurn | undefined;
  let sentMode: AgyInteractionMode | undefined;
  let sentRuntime: string | undefined;
  let resumed = false;
  let grant: HostMcpGrant | undefined;
  let ensoTools: readonly string[] = [];
  const timeout = options.timeoutMs ?? 15_000;

  const fail = (message: string) => {
    phase = transitionAgySession(phase, { type: 'fail', message });
  };

  let setupState: SetupState | undefined;
  proc.rpc.setNotificationHandler((method, params) => {
    if (method !== 'session/update') return;
    const update = record(params)?.update;
    if (setupState) noteConfigUpdate(setupState, update);
    if (!active) return;
    const reduced = reduceAgyUpdate(active.state, update, active.served);
    active.state = reduced.state;
    for (const effect of reduced.effects) active.onEvent?.(effect);
  });
  proc.rpc.setRequestHandler(async (method, params) => {
    if (method === 'fs/read_text_file') return readAllowed(params, options.readRoots, active);
    if (method === 'session/request_permission' || method === 'request_permission') {
      return answerPermission(params, active, ensoTools);
    }
    throw new AgyRpcError(-32601, method);
  });

  try {
    const init = await proc.rpc.request(
      'initialize',
      initializeParams(options.clientVersion),
      AbortSignal.timeout(timeout)
    );
    const parsedInit = parseInitialize(init);
    if (!parsedInit) throw new Error('agy initialize returned no version');
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
    const opened = await openProtocolSession(
      proc.rpc,
      cwd,
      options.resumeSessionId,
      timeout,
      grant ? [grant.server] : []
    );
    resumed = opened.resumed;
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

    return {
      phase: () => phase,
      sessionId: () =>
        phase.phase === 'session-ready' || phase.phase === 'prompting'
          ? phase.sessionId
          : undefined,
      resumed,
      ensoTools,
      async turn(input) {
        if (phase.phase !== 'session-ready') throw new Error(`agy session is ${phase.phase}`);
        const sessionId = phase.sessionId;
        phase = transitionAgySession(phase, { type: 'prompt-started' });
        const flags = instructionFlags(input, sentMode, sentRuntime);
        const blocks = buildAgyPrompt({
          messages: input.messages,
          interactionMode: flags.mode,
          includeInstructions: flags.includeInstructions,
          includeRuntimeInfo: flags.includeRuntimeInfo,
          modelLabel: input.modelLabel,
          ensoTools,
        });
        active = {
          signal: input.signal,
          ask: input.ask,
          served: [],
          state: emptyTranslatorState(),
          onEvent: input.onEvent,
          approvalMode: input.approvalMode,
          workspaceRoot: input.workspaceRoot,
        };
        const onAbort = () => proc.rpc.notify('session/cancel', { sessionId });
        input.signal?.addEventListener('abort', onAbort, { once: true });
        try {
          await alignSession(proc.rpc, sessionId, state, input);
          if (input.signal?.aborted) {
            onAbort();
            return emptyTurn(sessionId, 'aborted');
          }
          const result = await withCancelGrace(
            proc.rpc.request('session/prompt', { sessionId, prompt: blocks }),
            input.signal
          );
          if (!slashCommand(input.messages)) {
            if (flags.includeInstructions) sentMode = flags.mode;
            if (flags.includeRuntimeInfo) sentRuntime = flags.runtime;
          }
          const stopReason = input.signal?.aborted
            ? 'aborted'
            : stopFromPrompt(record(result)?.stopReason);
          return {
            stopReason,
            text: active.state.text,
            thinking: active.state.thinking,
            tools: active.state.tools,
            sessionId,
            usage: usageFromPrompt(result),
          };
        } catch (error) {
          if (input.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
            return emptyTurn(sessionId, 'aborted', active.state);
          }
          fail(error instanceof Error ? error.message : String(error));
          throw error;
        } finally {
          input.signal?.removeEventListener('abort', onAbort);
          active = undefined;
          if (phase.phase === 'prompting') {
            phase = transitionAgySession(phase, { type: 'prompt-finished' });
          }
        }
      },
      close: async () => {
        grant?.revoke();
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
  mcpServers: AcpHttpMcpServer[]
) {
  const signal = AbortSignal.timeout(timeoutMs);
  if (!resumeSessionId) {
    return {
      resumed: false,
      result: await rpc.request('session/new', { cwd, mcpServers }, signal),
    };
  }
  try {
    return {
      resumed: true,
      result: await rpc.request(
        'session/resume',
        { sessionId: resumeSessionId, cwd, mcpServers },
        signal
      ),
    };
  } catch (error) {
    if (error instanceof AgyRpcError && (error.code === -32000 || error.code === -32603))
      throw error;
    return {
      resumed: false,
      result: await rpc.request('session/new', { cwd, mcpServers }, signal),
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
  sentRuntime: string | undefined
) {
  const mode: AgyInteractionMode = input.planMode ? 'plan' : 'default';
  const runtime = runtimeInfoText(input.modelLabel);
  return {
    mode,
    runtime,
    includeInstructions: input.compressed === true || sentMode !== mode,
    includeRuntimeInfo: input.compressed === true || sentRuntime !== runtime,
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

function readAllowed(params: unknown, roots: readonly string[], active: ActiveTurn | undefined) {
  const row = record(params);
  const target = typeof row?.path === 'string' ? row.path : '';
  if (!fsReadAllowed(target, roots)) throw new AgyRpcError(-32602, 'path not allowed');
  const line = typeof row?.line === 'number' ? row.line : undefined;
  const limit = typeof row?.limit === 'number' ? row.limit : undefined;
  const content = sliceText(readFileSync(target, 'utf8'), line, limit);
  active?.served.push(target);
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
  active: ActiveTurn | undefined,
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

function withCancelGrace<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      timer = setTimeout(() => reject(abortError()), CANCEL_GRACE_MS);
    };
    if (signal.aborted) arm();
    else signal.addEventListener('abort', arm, { once: true });
    promise.then(resolve, reject).finally(() => {
      if (timer) clearTimeout(timer);
    });
  });
}

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
