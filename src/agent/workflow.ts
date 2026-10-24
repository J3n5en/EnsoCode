import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type {
  AgentControlToolRequest,
  AgentControlToolResponse,
  AgentTypeSpawnConfig,
  SubagentModelOption,
} from '@shared/types/agent';
import type {
  WorkflowMemberSnapshot,
  WorkflowPresetSummary,
  WorkflowRunSnapshot,
} from '@shared/types/workflow';
import { JSException, type JSValueHandle, QuickJS } from 'quickjs-wasi';
import { describeSubagentModels } from './subagent';
import { resolveWorkflowPresetArgs, type WorkflowPreset } from './workflowPresets';

const require = createRequire(import.meta.url);
let wasmModule: Promise<WebAssembly.Module> | undefined;

function loadQuickJsWasm(): Promise<WebAssembly.Module> {
  wasmModule ??= readFile(require.resolve('quickjs-wasi/quickjs.wasm')).then((bytes) =>
    WebAssembly.compile(bytes)
  );
  return wasmModule;
}

const MAX_AGENTS = 32;
const MAX_INFLIGHT = 4;
const TIMEOUT_MS = 10 * 60 * 1000;
const MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
const LOG_LIMIT = 20;

export interface WorkflowToolDeps {
  invoke(request: AgentControlToolRequest, signal?: AbortSignal): Promise<AgentControlToolResponse>;
  emit(run: WorkflowRunSnapshot): void;
  /** 后台运行结束时回投主 agent；未提供则不支持 background */
  notify?: (text: string, urgent: boolean) => void;
  /** 本会话在跑的运行（同步与后台）；宿主据此响应用户停止、会话释放时统一 abort */
  activeRuns?: Map<string, AbortController>;
  loadPreset?: (id: string) => WorkflowPreset | null;
  /** 会话建立时的可用预设快照，写进工具说明供模型挑选 */
  presets?: readonly WorkflowPresetSummary[];
  /** 与 subagent 工具同源：可选模型，以及哪些类型要求主 agent 选模型 */
  models?: readonly SubagentModelOption[];
  agentTypes?: readonly Pick<AgentTypeSpawnConfig, 'name' | 'allowModelOverride'>[];
  randomUuid?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function childIdOf(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.agentId !== 'string') return undefined;
  const id = value.agentId.trim();
  return id && id.length <= 80 ? id : undefined;
}

function clip(value: string, max: number): string {
  const text = value.trim();
  return text.length > max ? text.slice(0, max) : text;
}

const MAX_LISTED_PRESETS = 20;

function oneLine(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function presetCatalog(presets: readonly WorkflowPresetSummary[] | undefined): string {
  if (!presets?.length) return '';
  const lines = presets.slice(0, MAX_LISTED_PRESETS).map((preset) => {
    const args = preset.args.map((arg) =>
      arg.required
        ? `${arg.key}*`
        : arg.default !== undefined
          ? `${arg.key}=${JSON.stringify(arg.default)}`
          : arg.key
    );
    const head = `- ${preset.id}: ${oneLine(preset.name, 60)} — ${oneLine(preset.description, 160)}`;
    return args.length > 0 ? `${head} (args: ${args.join(', ')})` : head;
  });
  return `\nAvailable presets (pass the id as preset and string values in args; * = required):\n${lines.join('\n')}`;
}

export function workflowChildOutcome(
  spawnValue: unknown,
  reportValue: unknown
): { failed: boolean; text: string | null } {
  if (!isRecord(spawnValue) || !isRecord(spawnValue.report)) return { failed: true, text: null };
  const receipt = spawnValue.report;
  if (receipt.timedOut === true || receipt.interrupted === true)
    return { failed: true, text: null };
  const run = Array.isArray(receipt.runs) ? receipt.runs[0] : undefined;
  if (!isRecord(run) || run.status !== 'succeeded') return { failed: true, text: null };
  const budgetStopped = run.requestBudgetStop === true;
  const mark = (text: string): string =>
    budgetStopped ? `因请求预算停止，以下是已有的部分输出。\n${text}` : text;
  if (!isRecord(reportValue)) return { failed: false, text: '' };
  if (reportValue.value !== undefined) {
    return { failed: false, text: mark(JSON.stringify(reportValue.value)) };
  }
  return {
    failed: false,
    text: mark(typeof reportValue.text === 'string' ? reportValue.text : ''),
  };
}

function parseMeta(value: unknown): { name: string; description: string } | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === 'string' ? clip(value.name, 80) : '';
  const description = typeof value.description === 'string' ? clip(value.description, 240) : '';
  if (!name || !description) return null;
  return { name, description };
}

interface HostJob {
  id: string;
  op: 'agent' | 'phase' | 'log';
  payload: Record<string, unknown>;
}

class WorkflowRunState {
  readonly snapshot: WorkflowRunSnapshot;
  agentsStarted = 0;
  /** 顶层 model：由未自带 model、且类型要求选模型的 agent() 继承 */
  model: string | undefined;
  private memberSeq = 0;
  private batchSeq = 0;

  constructor(runId: string, meta: { name: string; description: string }) {
    this.snapshot = {
      runId,
      name: meta.name,
      description: meta.description,
      status: 'running',
      logs: [],
      members: [],
    };
  }

  phase(title: string): void {
    this.snapshot.phase = clip(title, 80);
  }

  nextBatch(): number {
    return ++this.batchSeq;
  }

  log(message: string): void {
    const line = clip(message, 160);
    if (!line) return;
    this.snapshot.logs = [...this.snapshot.logs, line].slice(-LOG_LIMIT);
  }

  startMember(
    label: string,
    phase: string | undefined,
    batch: number,
    prompt: string
  ): WorkflowMemberSnapshot {
    const member: WorkflowMemberSnapshot = {
      seq: ++this.memberSeq,
      label: clip(label, 80) || 'agent',
      batch,
      status: 'running',
    };
    const memberPhase = phase ? clip(phase, 80) : '';
    if (memberPhase) member.phase = memberPhase;
    const task = clip(prompt, 160);
    if (task) member.prompt = task;
    this.snapshot.members = [...this.snapshot.members, member];
    return member;
  }

  finishMember(
    seq: number,
    status: 'completed' | 'failed',
    detail: { result?: string; childId?: string } = {}
  ): void {
    const result = detail.result ? clip(detail.result, 160) : '';
    const childId = detail.childId ? clip(detail.childId, 80) : '';
    this.snapshot.members = this.snapshot.members.map((member) =>
      member.seq === seq
        ? {
            ...member,
            status,
            ...(result ? { result } : {}),
            ...(childId ? { childId } : {}),
          }
        : member
    );
  }

  finish(status: WorkflowRunSnapshot['status'], error?: string): void {
    this.snapshot.status = status;
    if (error) this.snapshot.error = clip(error, 400);
    if (status !== 'completed') {
      this.snapshot.members = this.snapshot.members.map((member) =>
        member.status === 'running' ? { ...member, status: 'failed' } : member
      );
    }
  }

  copy(): WorkflowRunSnapshot {
    return {
      ...this.snapshot,
      logs: [...this.snapshot.logs],
      members: this.snapshot.members.map((member) => ({ ...member })),
    };
  }
}

async function runAgent(
  deps: WorkflowToolDeps,
  state: WorkflowRunState,
  payload: Record<string, unknown>,
  signal: AbortSignal | undefined,
  publish: () => void
): Promise<{ fatal?: string; value: string | null }> {
  if (state.agentsStarted >= MAX_AGENTS) {
    return { fatal: `workflow agent cap exceeded (${MAX_AGENTS})`, value: null };
  }
  if (signal?.aborted) return { fatal: 'workflow cancelled', value: null };
  const agentType = typeof payload.agentType === 'string' ? payload.agentType : undefined;
  // 未指定类型时 Main 派发 worker
  const typeName = agentType ?? 'worker';
  const picks = deps.agentTypes?.some(
    (type) => type.name === typeName && type.allowModelOverride === true
  );
  const model = typeof payload.model === 'string' ? payload.model : picks ? state.model : undefined;
  if (picks && !model) {
    const names = (deps.models ?? []).map((option) => option.name).join(', ');
    return {
      fatal: `agent type "${typeName}" requires a model: call workflow again with model set to one of [${names}]`,
      value: null,
    };
  }
  state.agentsStarted += 1;
  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
  if (!prompt) return { fatal: 'agent() requires a non-empty prompt', value: null };
  const label =
    (typeof payload.label === 'string' && payload.label.trim()) ||
    prompt
      .split('\n')
      .find((line) => line.trim())
      ?.trim()
      .slice(0, 80) ||
    'agent';
  const explicitPhase = typeof payload.phase === 'string' ? payload.phase : undefined;
  const batch =
    typeof payload.batch === 'number' && payload.batch > 0 ? payload.batch : state.nextBatch();
  const member = state.startMember(label, explicitPhase || state.snapshot.phase, batch, prompt);
  publish();
  const schema = isRecord(payload.schema) ? payload.schema : undefined;
  let runId = '';
  try {
    // 不等待地 spawn 先拿到 runId，取消时才能真正停掉子代理
    const spawned = await deps.invoke({
      operation: 'spawn',
      mode: 'task',
      description: member.label,
      prompt,
      wait: false,
      ...(model ? { model } : {}),
      ...(agentType ? { agentType } : {}),
      ...(schema ? { schema } : {}),
    });
    if (!spawned.ok) {
      state.finishMember(member.seq, 'failed');
      publish();
      return { fatal: spawned.error, value: null };
    }
    const childId = childIdOf(spawned.value);
    runId =
      isRecord(spawned.value) && typeof spawned.value.runId === 'string' ? spawned.value.runId : '';
    if (!runId) throw new Error('missing run id');
    // Main 的 wait 单次最多 10 分钟（给模型的上限）；编排要等到成员真正结束
    let waited: AgentControlToolResponse;
    do {
      waited = await deps.invoke({ operation: 'wait', runIds: [runId], until: 'all' }, signal);
      if (signal?.aborted) throw new Error('workflow cancelled');
      if (!waited.ok) throw new Error(waited.error);
    } while (isRecord(waited.value) && waited.value.timedOut === true);
    const reported = await deps.invoke({ operation: 'report', runId });
    const outcome = workflowChildOutcome(
      { report: waited.value },
      reported.ok ? reported.value : undefined
    );
    state.finishMember(member.seq, outcome.failed ? 'failed' : 'completed', {
      ...(childId ? { childId } : {}),
      ...(outcome.text ? { result: outcome.text } : {}),
    });
    publish();
    if (!reported.ok && outcome.failed) return { fatal: reported.error, value: null };
    return { value: outcome.failed ? null : outcome.text };
  } catch (error) {
    state.finishMember(member.seq, 'failed');
    publish();
    if (signal?.aborted) {
      if (runId) await deps.invoke({ operation: 'stop', runId }).catch(() => undefined);
      return { fatal: 'workflow cancelled', value: null };
    }
    return {
      fatal: error instanceof Error ? error.message : String(error),
      value: null,
    };
  }
}

async function runScript(
  deps: WorkflowToolDeps,
  state: WorkflowRunState,
  script: string,
  args: unknown,
  signal: AbortSignal | undefined
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const publish = () => deps.emit(state.copy());
  publish();
  const queue: HostJob[] = [];
  let nextId = 0;
  const started = performance.now();
  let pausedMs = 0;
  let pauseStarted = 0;
  let hostInflight = 0;
  const elapsed = () =>
    performance.now() -
    started -
    pausedMs -
    (pauseStarted === 0 ? 0 : performance.now() - pauseStarted);
  const vm = await QuickJS.create({
    wasm: await loadQuickJsWasm(),
    memoryLimit: MEMORY_LIMIT_BYTES,
    interruptHandler: () => elapsed() > TIMEOUT_MS || Boolean(signal?.aborted),
  });
  const pause = () => {
    if (hostInflight++ === 0) pauseStarted = performance.now();
  };
  const resume = () => {
    if (hostInflight === 0) return;
    hostInflight -= 1;
    if (hostInflight > 0) return;
    if (pauseStarted === 0) return;
    pausedMs += performance.now() - pauseStarted;
    pauseStarted = 0;
  };
  try {
    vm.newFunction('__enqueue', (opHandle: JSValueHandle, jsonHandle: JSValueHandle) => {
      const op = opHandle.toString();
      if (op !== 'agent' && op !== 'phase' && op !== 'log') {
        throw new Error(`unsupported workflow hook: ${op}`);
      }
      let payload: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(jsonHandle.toString()) as unknown;
        if (isRecord(parsed)) payload = parsed;
      } catch {
        payload = {};
      }
      const id = String(++nextId);
      queue.push({ id, op, payload });
      return vm.newString(id);
    }).consume((handle) => vm.global.setProp('__enqueue', handle));
    const prelude = `
      const __waiters = new Map();
      globalThis.__settle = (id, ok, json) => {
        const waiter = __waiters.get(id);
        if (!waiter) return;
        __waiters.delete(id);
        if (ok) waiter.resolve(JSON.parse(json));
        else {
          const error = new Error(json);
          error.fatal = true;
          waiter.reject(error);
        }
      };
      function __call(op, payload) {
        const id = __enqueue(op, JSON.stringify(payload === undefined ? {} : payload));
        return new Promise((resolve, reject) => __waiters.set(id, { resolve, reject }));
      }
      function fatal(message) {
        const error = new Error(message);
        error.fatal = true;
        throw error;
      }
      globalThis.agent = async (prompt, opts) => {
        if (typeof prompt !== 'string' || !prompt.trim()) fatal('agent() requires a non-empty prompt');
        const options = opts === undefined ? {} : opts;
        if (!options || typeof options !== 'object' || Array.isArray(options)) fatal('agent() options must be an object');
        for (const key of Object.keys(options)) {
          if (!['label', 'phase', 'model', 'agentType', 'schema'].includes(key)) {
            fatal('agent() option "' + key + '" is not supported');
          }
        }
        const result = await __call('agent', { prompt, ...options });
        return result ? result.value : null;
      };
      globalThis.phase = (title) => {
        if (typeof title !== 'string' || !title.trim()) fatal('phase() requires a title');
        return __call('phase', { title });
      };
      globalThis.log = (message) => {
        if (typeof message !== 'string') fatal('log() requires a string');
        return __call('log', { message });
      };
      globalThis.parallel = async (thunks) => {
        if (!Array.isArray(thunks)) fatal('parallel() requires an array of functions');
        return Promise.all(thunks.map(async (fn, index) => {
          if (typeof fn !== 'function') fatal('parallel() item ' + index + ' is not a function');
          try { return await fn(); }
          catch (error) { if (error && error.fatal) throw error; return null; }
        }));
      };
      globalThis.pipeline = async (items, ...stages) => {
        if (!Array.isArray(items)) fatal('pipeline() requires an items array');
        if (stages.length === 0 || stages.some((stage) => typeof stage !== 'function')) {
          fatal('pipeline() requires function stages');
        }
        return Promise.all(items.map(async (item, index) => {
          let prev;
          for (const stage of stages) {
            try { prev = await stage(prev, item, index); }
            catch (error) { if (error && error.fatal) throw error; return null; }
          }
          return prev;
        }));
      };
      globalThis.args = ${JSON.stringify(args ?? {})};
    `;
    vm.evalCode(prelude, 'enso-workflow:prelude.js').dispose();
    const resultHandle = vm.evalCode(`(async () => {\n${script}\n})()`, 'enso-workflow.js');
    const done = vm.resolvePromise(resultHandle);
    let settled: Awaited<typeof done> | undefined;
    const finish = done.then((value) => {
      settled = value;
      return value;
    });
    const settleJob = (id: string, ok: boolean, payload: unknown) => {
      const settle = vm.global.getProp('__settle');
      const idHandle = vm.newString(id);
      const jsonHandle = vm.newString(ok ? JSON.stringify(payload) : String(payload));
      try {
        vm.callFunction(
          settle,
          vm.undefined,
          idHandle,
          ok ? vm.true : vm.false,
          jsonHandle
        ).dispose();
      } finally {
        settle.dispose();
        idHandle.dispose();
        jsonHandle.dispose();
      }
    };
    const runJob = async (job: HostJob) => {
      pause();
      try {
        if (job.op === 'phase') {
          state.phase(String(job.payload.title ?? ''));
          publish();
          settleJob(job.id, true, {});
        } else if (job.op === 'log') {
          state.log(String(job.payload.message ?? ''));
          publish();
          settleJob(job.id, true, {});
        } else {
          const result = await runAgent(deps, state, job.payload, signal, publish);
          if (result.fatal) settleJob(job.id, false, result.fatal);
          else settleJob(job.id, true, { value: result.value });
        }
        vm.executePendingJobs();
      } catch {
        /* vm already tearing down */
      } finally {
        resume();
      }
    };
    const drain = async () => {
      const wave = queue.splice(0);
      const setup = wave.filter((job) => job.op !== 'agent');
      const agents = wave.filter((job) => job.op === 'agent');
      for (const job of setup) await runJob(job);
      const batch = agents.length > 0 ? state.nextBatch() : undefined;
      const running = new Set<Promise<void>>();
      let index = 0;
      const launch = () => {
        while (index < agents.length && running.size < MAX_INFLIGHT) {
          const job = agents[index++];
          if (!job) break;
          if (batch !== undefined) job.payload = { ...job.payload, batch };
          let task!: Promise<void>;
          task = runJob(job).finally(() => running.delete(task));
          running.add(task);
        }
      };
      launch();
      while (running.size > 0) {
        await Promise.race(running);
        launch();
      }
    };
    while (!settled) {
      if (signal?.aborted) return { ok: false, error: 'workflow cancelled' };
      if (elapsed() > TIMEOUT_MS) return { ok: false, error: 'workflow timeout exceeded' };
      vm.executePendingJobs();
      await Promise.resolve();
      if (settled) break;
      if (queue.length > 0) await drain();
      else await Promise.race([finish, new Promise((resolve) => setImmediate(resolve))]);
    }
    if (!settled) return { ok: false, error: 'workflow did not settle' };
    if ('error' in settled) {
      const message =
        settled.error instanceof JSException
          ? settled.error.message || settled.error.name
          : String(vm.dump(settled.error));
      settled.error.dispose();
      return { ok: false, error: message || 'workflow failed' };
    }
    const value = vm.dump(settled.value);
    settled.value.dispose();
    return { ok: true, value };
  } finally {
    vm.dispose();
  }
}

/** 用户从侧边栏停止时的 abort reason，据此告诉模型不要重跑 */
export const WORKFLOW_STOPPED_BY_USER = 'workflow-stopped-by-user';
const USER_STOP_TEXT = 'was stopped by the user — do not restart it';

export function createWorkflowTool(deps: WorkflowToolDeps): ToolDefinition {
  const modelNames = (deps.models ?? []).map((option) => option.name);
  const modelNotes = describeSubagentModels(deps.models ?? []);
  const pickTypes = (deps.agentTypes ?? [])
    .filter((type) => type.allowModelOverride === true)
    .map((type) => type.name);
  const settle = async (
    state: WorkflowRunState,
    script: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: string; thrown?: unknown }> => {
    let result: Awaited<ReturnType<typeof runScript>>;
    try {
      result = await runScript(deps, state, script, args, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.finish(signal?.aborted ? 'cancelled' : 'failed', message);
      deps.emit(state.copy());
      return { ok: false, error: message, thrown: error };
    }
    if (!result.ok) {
      state.finish(
        signal?.aborted || result.error === 'workflow cancelled' ? 'cancelled' : 'failed',
        result.error
      );
    } else {
      state.finish('completed');
    }
    deps.emit(state.copy());
    return result;
  };
  const completedText = (name: string, state: WorkflowRunState, value: unknown) =>
    `workflow "${name}" completed (${state.agentsStarted} agents).\nReturn value:\n${JSON.stringify(value, null, 2)}`;

  return {
    name: 'workflow',
    label: 'Workflow',
    description:
      'Run a JavaScript workflow that fans work out across subagents. Use only when the user asks for a workflow or a large multi-agent fan-out. ' +
      'Pass either preset (id of a saved workflow) or script + meta. ' +
      'Set background:true to return a runId immediately; the result arrives later as a notification. Pass stop:<runId> alone to cancel a background run. ' +
      'The script is plain JavaScript with top-level await and must return a JSON value. Hooks: agent(prompt, opts?), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args. ' +
      'A failed child resolves to null. Bad hook arguments fail the whole run. The script cannot use filesystem, network, timers, or Node APIs. Status is shown in the side panel.' +
      presetCatalog(deps.presets),
    promptSnippet:
      'workflow: run a saved preset or write a JavaScript orchestration script that fans subagents out. Use for an explicit workflow request, a large fan-out, or a task a listed preset clearly fits. One or two delegations should use subagent.',
    promptGuidelines: [
      'Use workflow when the user asks for a workflow, for large multi-agent orchestration, or when a listed preset clearly fits the task.',
      'Prefer a listed preset over writing an equivalent script; pass its id and args. Use only listed preset ids or ids the user gave you, and never rewrite a preset as a script.',
      'Choose background:true when the run is long and you have other work to do or the user should not wait; keep it off when the next step needs the result. Do not poll a background run — wait for its notification.',
      'script is plain JavaScript, not TypeScript, with top-level await. End with return <json>.',
      'agent() options are only label, phase, model, agentType, and schema. Anything else fails the run.',
      ...(modelNames.length > 0
        ? [
            `model must be copied exactly from the model enum: ${modelNames.join(', ')}.${modelNotes ? ` ${modelNotes}.` : ''} Top-level model applies to every agent() without its own model whose agent type requires one${
              pickTypes.length > 0
                ? ` (${pickTypes.join(', ')}; agent() without agentType uses worker). Pass it when running presets that use these types`
                : ''
            }.`,
          ]
        : []),
      'Child failure returns null. Do not treat null as success without checking it.',
    ],
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        preset: {
          type: 'string',
          description: 'Id of a saved workflow preset to run instead of script + meta.',
        },
        script: {
          type: 'string',
          description:
            'Plain JavaScript body. Top-level await is allowed. End with return <json-value>. Required without preset.',
        },
        meta: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'description'],
          description: 'Workflow identity. Plain JSON, never code. Required without preset.',
          properties: {
            name: { type: 'string', description: 'Short kebab-case workflow name.' },
            description: { type: 'string', description: 'One-line description of the workflow.' },
          },
        },
        args: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional JSON object exposed to the script as the args global.',
        },
        background: {
          type: 'boolean',
          description:
            'Default false. When true, return a runId immediately and deliver the result later as a notification.',
        },
        ...(modelNames.length > 0
          ? {
              model: {
                type: 'string',
                enum: modelNames,
                description: `Model for every agent() without its own model whose agent type requires one. Exact id from the enum.${
                  modelNotes ? ` ${modelNotes}.` : ''
                }`,
              },
            }
          : {}),
        stop: {
          type: 'string',
          description: 'runId of a background workflow to cancel. Pass it without other fields.',
        },
      },
    } as unknown as ToolDefinition['parameters'],
    async execute(_toolCallId, params, signal) {
      const record = (params ?? {}) as Record<string, unknown>;
      const stopId = typeof record.stop === 'string' ? record.stop.trim() : '';
      if (stopId) {
        const controller = deps.activeRuns?.get(stopId);
        if (!controller) throw new Error(`no running background workflow: ${stopId}`);
        // 先摘除再 abort：收尾时发现已不在表里，就不再通知（模型已由本次返回知情）
        deps.activeRuns?.delete(stopId);
        controller.abort();
        return {
          content: [{ type: 'text', text: `workflow ${stopId} stopped` }],
          details: { runId: stopId, stopped: true },
        };
      }
      const background = record.background === true;
      if (background && (!deps.notify || !deps.activeRuns)) {
        throw new Error('background workflows are unavailable in this session');
      }
      if (record.args !== undefined && !isRecord(record.args)) {
        throw new Error('workflow args must be a JSON object');
      }
      const model = typeof record.model === 'string' ? record.model.trim() : '';
      if (model && !modelNames.includes(model)) {
        throw new Error(`unknown model "${model}". Available: [${modelNames.join(', ')}]`);
      }
      const presetId = typeof record.preset === 'string' ? record.preset.trim() : '';
      let script = typeof record.script === 'string' ? record.script : '';
      let meta = parseMeta(record.meta);
      let args: Record<string, unknown> = isRecord(record.args) ? record.args : {};
      if (presetId) {
        if (script.trim()) throw new Error('workflow accepts either preset or script, not both');
        const preset = deps.loadPreset?.(presetId) ?? null;
        if (!preset) throw new Error(`unknown workflow preset: ${presetId}`);
        const resolved = resolveWorkflowPresetArgs(preset, args);
        if (!resolved.ok) throw new Error(resolved.error);
        script = preset.script;
        meta = { name: preset.name, description: preset.description };
        args = resolved.args;
      }
      if (!script.trim() || !meta)
        throw new Error('workflow requires preset, or script with meta.name and meta.description');
      const state = new WorkflowRunState(deps.randomUuid?.() ?? crypto.randomUUID(), meta);
      state.model = model || undefined;
      const runId = state.snapshot.runId;
      const name = meta.name;
      const controller = new AbortController();
      const activeRuns = deps.activeRuns;
      activeRuns?.set(runId, controller);
      // 仍在表里 = 不是模型自己 stop 的（stop 会先摘除），收尾需要告知结果
      const release = () => {
        if (activeRuns?.get(runId) !== controller) return false;
        activeRuns.delete(runId);
        return true;
      };
      const byUser = () => controller.signal.reason === WORKFLOW_STOPPED_BY_USER;
      if (background && deps.notify) {
        const { notify } = deps;
        void settle(state, script, args, controller.signal).then((result) => {
          if (!release()) return;
          notify(
            result.ok
              ? `Background run ${runId}: ${completedText(name, state, result.value)}`
              : byUser()
                ? `Background workflow "${name}" (runId ${runId}) ${USER_STOP_TEXT}.`
                : `Background workflow "${name}" (runId ${runId}) ${
                    controller.signal.aborted ? 'was cancelled' : 'failed'
                  }: ${result.error}`,
            !result.ok
          );
        });
        return {
          content: [
            {
              type: 'text',
              text: `workflow "${name}" started in background (runId ${runId}). You will be notified when it finishes; keep working or return to the user meanwhile. Use stop:"${runId}" to cancel.`,
            },
          ],
          details: { runId, background: true },
        };
      }
      const result = await settle(
        state,
        script,
        args,
        signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
      ).finally(release);
      if (!result.ok) {
        if (result.thrown !== undefined && !byUser()) throw result.thrown;
        return {
          content: [
            {
              type: 'text',
              text: byUser() ? `workflow "${name}" ${USER_STOP_TEXT}` : result.error,
            },
          ],
          details: { runId, agentsStarted: state.agentsStarted },
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: completedText(name, state, result.value) }],
        details: {
          runId,
          agentsStarted: state.agentsStarted,
          result: result.value,
        },
      };
    },
  };
}
